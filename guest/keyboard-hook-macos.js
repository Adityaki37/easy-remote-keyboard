"use strict";

const koffi = require("koffi");
const { isBlockedCombo, DEFAULT_ALLOWED_CODES } = require("../shared/protocol");
const { CODE_TO_MAC_KEY } = require("../host/macos");

if (process.platform !== "darwin") {
  throw new Error("The macOS keyboard hook can only run on macOS.");
}

const APPLICATION_SERVICES = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const appServices = koffi.load(APPLICATION_SERVICES);
const coreFoundation = koffi.load(CORE_FOUNDATION);

const kCGSessionEventTap = 1;
const kCGHeadInsertEventTap = 0;
const kCGEventTapOptionDefault = 0;
const kCGEventKeyDown = 10;
const kCGEventKeyUp = 11;
const kCGEventFlagsChanged = 12;
const kCGEventTapDisabledByTimeout = 0xfffffffe;
const kCGKeyboardEventKeycode = 9;

const CODE_BY_MAC_KEY = Object.freeze(
  Object.fromEntries(Object.entries(CODE_TO_MAC_KEY).map(([code, key]) => [key, code]))
);

const MODIFIER_FLAG_BY_CODE = Object.freeze({
  ShiftLeft: 1 << 17,
  ShiftRight: 1 << 17,
  ControlLeft: 1 << 18,
  ControlRight: 1 << 18,
  AltLeft: 1 << 19,
  AltRight: 1 << 19
});

const CGEventTapCallBack = koffi.proto("uintptr CGEventTapCallBack(uintptr proxy, uint32 type, uintptr event, uintptr refcon)");
const CGEventTapCreate = appServices.func("uintptr CGEventTapCreate(uint32 tap, uint32 place, uint32 options, uint64 eventsOfInterest, CGEventTapCallBack *callback, uintptr userInfo)");
const CGEventTapEnable = appServices.func("void CGEventTapEnable(uintptr tap, bool enable)");
const CGEventGetIntegerValueField = appServices.func("int64 CGEventGetIntegerValueField(uintptr event, uint32 field)");
const CGEventGetFlags = appServices.func("uint64 CGEventGetFlags(uintptr event)");
const CFMachPortCreateRunLoopSource = coreFoundation.func("uintptr CFMachPortCreateRunLoopSource(uintptr allocator, uintptr port, intptr order)");
const CFRunLoopGetCurrent = coreFoundation.func("uintptr CFRunLoopGetCurrent()");
const CFRunLoopAddSource = coreFoundation.func("void CFRunLoopAddSource(uintptr rl, uintptr source, uintptr mode)");
const CFRunLoopRunInMode = coreFoundation.func("int32 CFRunLoopRunInMode(uintptr mode, double seconds, bool returnAfterSourceHandled)");
const CFRelease = coreFoundation.func("void CFRelease(uintptr cf)");

const defaultRunLoopMode = koffi.decode(coreFoundation.symbol("kCFRunLoopDefaultMode", "uintptr"), "uintptr");
const commonRunLoopModes = koffi.decode(coreFoundation.symbol("kCFRunLoopCommonModes", "uintptr"), "uintptr");

function eventMask(...types) {
  return types.reduce((mask, type) => mask | (1n << BigInt(type)), 0n);
}

class KeyboardHook {
  constructor({ onInput, onToggle, allowedCodes = DEFAULT_ALLOWED_CODES, suppressLocal = true }) {
    this.onInput = onInput;
    this.onToggle = onToggle;
    this.allowedCodes = allowedCodes;
    this.suppressLocal = suppressLocal;
    this.tap = 0;
    this.source = 0;
    this.callback = null;
    this.pump = null;
    this.armed = false;
    this.seq = 0;
    this.held = new Set();
    this.activeCodes = new Set();
    this.ignoredEvents = new Map();
  }

  start() {
    if (this.tap) return;

    this.callback = koffi.register((proxy, type, event) => {
      if (type === kCGEventTapDisabledByTimeout && this.tap) {
        CGEventTapEnable(this.tap, true);
        return event;
      }
      return this.handleEvent(type, event);
    }, koffi.pointer(CGEventTapCallBack));

    this.tap = CGEventTapCreate(
      kCGSessionEventTap,
      kCGHeadInsertEventTap,
      kCGEventTapOptionDefault,
      eventMask(kCGEventKeyDown, kCGEventKeyUp, kCGEventFlagsChanged),
      this.callback,
      0
    );

    if (!this.tap) {
      koffi.unregister(this.callback);
      this.callback = null;
      throw new Error("Could not create macOS event tap. Grant Input Monitoring permission, then restart the app.");
    }

    this.source = CFMachPortCreateRunLoopSource(0, this.tap, 0);
    if (!this.source) {
      this.stop();
      throw new Error("Could not create macOS run loop source for event tap.");
    }

    CFRunLoopAddSource(CFRunLoopGetCurrent(), this.source, commonRunLoopModes);
    CGEventTapEnable(this.tap, true);

    this.pump = setInterval(() => {
      CFRunLoopRunInMode(defaultRunLoopMode, 0.001, true);
    }, 4);
  }

  stop() {
    this.releaseAll("hook stopped");
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    if (this.tap) CGEventTapEnable(this.tap, false);
    if (this.source) CFRelease(this.source);
    if (this.tap) CFRelease(this.tap);
    this.source = 0;
    this.tap = 0;
    if (this.callback) koffi.unregister(this.callback);
    this.callback = null;
  }

  setArmed(armed) {
    if (this.armed === armed) return;
    this.armed = armed;
    if (!armed) this.releaseAll("capture paused");
  }

  releaseAll(reason) {
    for (const code of [...this.held]) {
      this.onInput({
        code,
        down: false,
        location: 0,
        timestamp: Date.now(),
        sequence: ++this.seq,
        reason
      });
      this.held.delete(code);
    }
    this.activeCodes.clear();
  }

  ignoreNext(code, down) {
    const key = `${code}:${down ? 1 : 0}`;
    this.ignoredEvents.set(key, (this.ignoredEvents.get(key) || 0) + 1);
  }

  takeIgnored(code, down) {
    const key = `${code}:${down ? 1 : 0}`;
    const count = this.ignoredEvents.get(key) || 0;
    if (!count) return false;
    if (count === 1) this.ignoredEvents.delete(key);
    else this.ignoredEvents.set(key, count - 1);
    return true;
  }

  handleEvent(type, event) {
    const keyCode = Number(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
    const code = CODE_BY_MAC_KEY[keyCode];
    if (!code) {
      return this.armed && this.suppressLocal ? 0 : event;
    }

    if (type === kCGEventFlagsChanged) {
      const flags = Number(CGEventGetFlags(event));
      const down = Boolean(flags & (MODIFIER_FLAG_BY_CODE[code] || 0));
      return this.handleKey(code, down, event);
    }

    if (type === kCGEventKeyDown || type === kCGEventKeyUp) {
      return this.handleKey(code, type === kCGEventKeyDown, event);
    }

    return event;
  }

  handleKey(code, down, event) {
    if (down && code === "F12" && (this.activeCodes.has("ControlLeft") || this.activeCodes.has("ControlRight")) && (this.activeCodes.has("AltLeft") || this.activeCodes.has("AltRight"))) {
      this.onToggle();
      return this.suppressLocal ? 0 : event;
    }

    if (this.takeIgnored(code, down)) {
      return event;
    }

    if (down) this.activeCodes.add(code);
    else this.activeCodes.delete(code);

    if (!this.armed) {
      return event;
    }

    if (!this.allowedCodes.has(code) || isBlockedCombo(code, this.activeCodes)) {
      return this.suppressLocal ? 0 : event;
    }

    if (down) {
      if (this.held.has(code)) return this.suppressLocal ? 0 : event;
      this.held.add(code);
    } else {
      if (!this.held.has(code)) return this.suppressLocal ? 0 : event;
      this.held.delete(code);
    }

    this.onInput({
      code,
      down,
      location: 0,
      timestamp: Date.now(),
      sequence: ++this.seq
    });

    return this.suppressLocal ? 0 : event;
  }
}

module.exports = {
  KeyboardHook
};
