"use strict";

const koffi = require("koffi");
const { codeFromVk, isBlockedCombo, DEFAULT_ALLOWED_CODES } = require("../shared/protocol");

if (process.platform !== "win32") {
  throw new Error("The guest app currently supports Windows only.");
}

const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const PM_REMOVE = 0x0001;
const LLKHF_INJECTED = 0x10;
const VK_F12 = 0x7b;

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const KBDLLHOOKSTRUCT = koffi.struct("KBDLLHOOKSTRUCT", {
  vkCode: "uint32",
  scanCode: "uint32",
  flags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});

const MSG = koffi.struct("MSG", {
  hwnd: "uintptr",
  message: "uint32",
  wParam: "uintptr",
  lParam: "intptr",
  time: "uint32",
  pt_x: "int32",
  pt_y: "int32"
});

const LowLevelKeyboardProc = koffi.proto("intptr __stdcall LowLevelKeyboardProc(int nCode, uintptr wParam, intptr lParam)");
const SetWindowsHookExW = user32.func("uintptr __stdcall SetWindowsHookExW(int idHook, LowLevelKeyboardProc *lpfn, uintptr hmod, uint32 dwThreadId)");
const CallNextHookEx = user32.func("intptr __stdcall CallNextHookEx(uintptr hhk, int nCode, uintptr wParam, intptr lParam)");
const UnhookWindowsHookEx = user32.func("bool __stdcall UnhookWindowsHookEx(uintptr hhk)");
const PeekMessageW = user32.func("bool __stdcall PeekMessageW(_Out_ MSG *lpMsg, uintptr hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)");
const TranslateMessage = user32.func("bool __stdcall TranslateMessage(MSG *lpMsg)");
const DispatchMessageW = user32.func("intptr __stdcall DispatchMessageW(MSG *lpMsg)");
const GetModuleHandleW = kernel32.func("uintptr __stdcall GetModuleHandleW(str16 lpModuleName)");

class KeyboardHook {
  constructor({ onInput, onToggle, allowedCodes = DEFAULT_ALLOWED_CODES, suppressLocal = true }) {
    this.onInput = onInput;
    this.onToggle = onToggle;
    this.allowedCodes = allowedCodes;
    this.suppressLocal = suppressLocal;
    this.hook = 0;
    this.callback = null;
    this.pump = null;
    this.armed = false;
    this.seq = 0;
    this.held = new Set();
    this.activeCodes = new Set();
    this.ignoredEvents = new Map();
  }

  start() {
    if (this.hook) return;
    this.callback = koffi.register((nCode, wParam, lParam) => {
      if (nCode < 0) return CallNextHookEx(this.hook, nCode, wParam, lParam);
      return this.handleKeyboard(Number(wParam), lParam);
    }, koffi.pointer(LowLevelKeyboardProc));

    this.hook = SetWindowsHookExW(WH_KEYBOARD_LL, this.callback, GetModuleHandleW(null), 0);
    if (!this.hook) {
      koffi.unregister(this.callback);
      this.callback = null;
      throw new Error("SetWindowsHookExW failed.");
    }

    const msg = {};
    this.pump = setInterval(() => {
      while (PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) {
        TranslateMessage(msg);
        DispatchMessageW(msg);
      }
    }, 8);
  }

  stop() {
    this.releaseAll("hook stopped");
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    if (this.hook) UnhookWindowsHookEx(this.hook);
    this.hook = 0;
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

  handleKeyboard(message, lParam) {
    const info = koffi.decode(lParam, KBDLLHOOKSTRUCT);
    if (info.flags & LLKHF_INJECTED) {
      return CallNextHookEx(this.hook, 0, message, lParam);
    }

    const down = message === WM_KEYDOWN || message === WM_SYSKEYDOWN;
    const up = message === WM_KEYUP || message === WM_SYSKEYUP;
    if (!down && !up) {
      return CallNextHookEx(this.hook, 0, message, lParam);
    }

    if (down && info.vkCode === VK_F12 && (this.activeCodes.has("ControlLeft") || this.activeCodes.has("ControlRight")) && (this.activeCodes.has("AltLeft") || this.activeCodes.has("AltRight"))) {
      this.onToggle();
      return 1;
    }

    const code = codeFromVk(info.vkCode, info.scanCode, info.flags);
    if (!code) {
      return this.armed && this.suppressLocal ? 1 : CallNextHookEx(this.hook, 0, message, lParam);
    }

    if (this.takeIgnored(code, down)) {
      return CallNextHookEx(this.hook, 0, message, lParam);
    }

    if (down) this.activeCodes.add(code);
    else this.activeCodes.delete(code);

    if (!this.armed) {
      return CallNextHookEx(this.hook, 0, message, lParam);
    }

    if (!this.allowedCodes.has(code) || isBlockedCombo(code, this.activeCodes)) {
      return this.suppressLocal ? 1 : CallNextHookEx(this.hook, 0, message, lParam);
    }

    if (down) {
      if (this.held.has(code)) return this.suppressLocal ? 1 : CallNextHookEx(this.hook, 0, message, lParam);
      this.held.add(code);
    } else {
      if (!this.held.has(code)) return this.suppressLocal ? 1 : CallNextHookEx(this.hook, 0, message, lParam);
      this.held.delete(code);
    }

    this.onInput({
      code,
      down,
      location: 0,
      scanCode: info.scanCode,
      timestamp: Date.now(),
      sequence: ++this.seq
    });

    return this.suppressLocal ? 1 : CallNextHookEx(this.hook, 0, message, lParam);
  }
}

module.exports = {
  KeyboardHook
};
