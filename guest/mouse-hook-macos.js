"use strict";

const koffi = require("koffi");

if (process.platform !== "darwin") {
  throw new Error("The macOS mouse hook can only run on macOS.");
}

const APPLICATION_SERVICES = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const appServices = koffi.load(APPLICATION_SERVICES);
const coreFoundation = koffi.load(CORE_FOUNDATION);

const kCGSessionEventTap = 1;
const kCGHeadInsertEventTap = 0;
const kCGEventTapOptionDefault = 0;
const kCGEventLeftMouseDown = 1;
const kCGEventLeftMouseUp = 2;
const kCGEventRightMouseDown = 3;
const kCGEventRightMouseUp = 4;
const kCGEventMouseMoved = 5;
const kCGEventLeftMouseDragged = 6;
const kCGEventRightMouseDragged = 7;
const kCGEventOtherMouseDown = 25;
const kCGEventOtherMouseUp = 26;
const kCGEventOtherMouseDragged = 27;
const kCGEventScrollWheel = 22;
const kCGEventTapDisabledByTimeout = 0xfffffffe;
const kCGScrollWheelEventDeltaAxis1 = 11;
const kCGScrollWheelEventDeltaAxis2 = 12;

const CGPoint = koffi.struct("CGPoint_MOUSE", {
  x: "double",
  y: "double"
});

const CGEventTapCallBack = koffi.proto("uintptr CGMouseEventTapCallBack(uintptr proxy, uint32 type, uintptr event, uintptr refcon)");
const CGEventTapCreate = appServices.func("uintptr CGEventTapCreate(uint32 tap, uint32 place, uint32 options, uint64 eventsOfInterest, CGMouseEventTapCallBack *callback, uintptr userInfo)");
const CGEventTapEnable = appServices.func("void CGEventTapEnable(uintptr tap, bool enable)");
const CGEventGetIntegerValueField = appServices.func("int64 CGEventGetIntegerValueField(uintptr event, uint32 field)");
const CGEventGetLocation = appServices.func("void CGEventGetLocation(uintptr event, _Out_ CGPoint_MOUSE *point)");
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

class MouseHook {
  constructor({ onMouse, suppressLocal = true }) {
    this.onMouse = onMouse;
    this.suppressLocal = suppressLocal;
    this.tap = 0;
    this.source = 0;
    this.callback = null;
    this.pump = null;
    this.armed = false;
    this.seq = 0;
    this.lastPoint = null;
  }

  start() {
    if (this.tap) return;
    this.callback = koffi.register((proxy, type, event) => {
      if (type === kCGEventTapDisabledByTimeout && this.tap) {
        CGEventTapEnable(this.tap, true);
        return event;
      }
      return this.handleMouse(type, event);
    }, koffi.pointer(CGEventTapCallBack));

    this.tap = CGEventTapCreate(
      kCGSessionEventTap,
      kCGHeadInsertEventTap,
      kCGEventTapOptionDefault,
      eventMask(
        kCGEventMouseMoved,
        kCGEventLeftMouseDragged,
        kCGEventRightMouseDragged,
        kCGEventOtherMouseDragged,
        kCGEventLeftMouseDown,
        kCGEventLeftMouseUp,
        kCGEventRightMouseDown,
        kCGEventRightMouseUp,
        kCGEventOtherMouseDown,
        kCGEventOtherMouseUp,
        kCGEventScrollWheel
      ),
      this.callback,
      0
    );
    if (!this.tap) {
      koffi.unregister(this.callback);
      this.callback = null;
      throw new Error("Could not create macOS mouse event tap. Grant Input Monitoring permission, then restart the app.");
    }

    this.source = CFMachPortCreateRunLoopSource(0, this.tap, 0);
    if (!this.source) {
      this.stop();
      throw new Error("Could not create macOS mouse run loop source.");
    }

    CFRunLoopAddSource(CFRunLoopGetCurrent(), this.source, commonRunLoopModes);
    CGEventTapEnable(this.tap, true);
    this.pump = setInterval(() => {
      CFRunLoopRunInMode(defaultRunLoopMode, 0.001, true);
    }, 4);
  }

  stop() {
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
    this.armed = armed;
    this.lastPoint = null;
  }

  handleMouse(type, event) {
    const payload = this.eventFromType(type, event);
    if (!payload) return event;
    if (!this.armed) return event;
    this.onMouse({
      ...payload,
      timestamp: Date.now(),
      sequence: ++this.seq
    });
    return this.suppressLocal ? 0 : event;
  }

  eventFromType(type, event) {
    if (type === kCGEventMouseMoved || type === kCGEventLeftMouseDragged || type === kCGEventRightMouseDragged || type === kCGEventOtherMouseDragged) {
      const point = {};
      CGEventGetLocation(event, point);
      if (!this.lastPoint) {
        this.lastPoint = point;
        return null;
      }
      const dx = Math.round(point.x - this.lastPoint.x);
      const dy = Math.round(point.y - this.lastPoint.y);
      this.lastPoint = point;
      if (!dx && !dy) return null;
      return { kind: "move", dx, dy };
    }
    if (type === kCGEventLeftMouseDown || type === kCGEventLeftMouseUp) {
      return { kind: "button", button: "left", down: type === kCGEventLeftMouseDown };
    }
    if (type === kCGEventRightMouseDown || type === kCGEventRightMouseUp) {
      return { kind: "button", button: "right", down: type === kCGEventRightMouseDown };
    }
    if (type === kCGEventOtherMouseDown || type === kCGEventOtherMouseUp) {
      return { kind: "button", button: "middle", down: type === kCGEventOtherMouseDown };
    }
    if (type === kCGEventScrollWheel) {
      const vertical = Number(CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1));
      const horizontal = Number(CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis2));
      if (vertical) return { kind: "wheel", axis: "vertical", delta: vertical * 120 };
      if (horizontal) return { kind: "wheel", axis: "horizontal", delta: horizontal * 120 };
    }
    return null;
  }
}

module.exports = {
  MouseHook
};
