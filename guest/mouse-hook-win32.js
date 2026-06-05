"use strict";

const koffi = require("koffi");

if (process.platform !== "win32") {
  throw new Error("The Windows mouse hook can only run on Windows.");
}

const WH_MOUSE_LL = 14;
const PM_REMOVE = 0x0001;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_MBUTTONDOWN = 0x0207;
const WM_MBUTTONUP = 0x0208;
const WM_MOUSEWHEEL = 0x020a;
const WM_MOUSEHWHEEL = 0x020e;
const LLMHF_INJECTED = 0x01;

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const POINT = koffi.struct("POINT", {
  x: "int32",
  y: "int32"
});

const MSLLHOOKSTRUCT = koffi.struct("MSLLHOOKSTRUCT", {
  pt: POINT,
  mouseData: "uint32",
  flags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});

const MSG = koffi.struct("MSG_MOUSE", {
  hwnd: "uintptr",
  message: "uint32",
  wParam: "uintptr",
  lParam: "intptr",
  time: "uint32",
  pt_x: "int32",
  pt_y: "int32"
});

const LowLevelMouseProc = koffi.proto("intptr __stdcall LowLevelMouseProc(int nCode, uintptr wParam, intptr lParam)");
const SetWindowsHookExW = user32.func("uintptr __stdcall SetWindowsHookExW(int idHook, LowLevelMouseProc *lpfn, uintptr hmod, uint32 dwThreadId)");
const CallNextHookEx = user32.func("intptr __stdcall CallNextHookEx(uintptr hhk, int nCode, uintptr wParam, intptr lParam)");
const UnhookWindowsHookEx = user32.func("bool __stdcall UnhookWindowsHookEx(uintptr hhk)");
const PeekMessageW = user32.func("bool __stdcall PeekMessageW(_Out_ MSG_MOUSE *lpMsg, uintptr hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)");
const TranslateMessage = user32.func("bool __stdcall TranslateMessage(MSG_MOUSE *lpMsg)");
const DispatchMessageW = user32.func("intptr __stdcall DispatchMessageW(MSG_MOUSE *lpMsg)");
const GetModuleHandleW = kernel32.func("uintptr __stdcall GetModuleHandleW(str16 lpModuleName)");

class MouseHook {
  constructor({ onMouse, suppressLocal = true }) {
    this.onMouse = onMouse;
    this.suppressLocal = suppressLocal;
    this.hook = 0;
    this.callback = null;
    this.pump = null;
    this.armed = false;
    this.seq = 0;
    this.lastPoint = null;
  }

  start() {
    if (this.hook) return;
    this.callback = koffi.register((nCode, wParam, lParam) => {
      if (nCode < 0) return CallNextHookEx(this.hook, nCode, wParam, lParam);
      return this.handleMouse(Number(wParam), lParam);
    }, koffi.pointer(LowLevelMouseProc));

    this.hook = SetWindowsHookExW(WH_MOUSE_LL, this.callback, GetModuleHandleW(null), 0);
    if (!this.hook) {
      koffi.unregister(this.callback);
      this.callback = null;
      throw new Error("SetWindowsHookExW mouse hook failed.");
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
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    if (this.hook) UnhookWindowsHookEx(this.hook);
    this.hook = 0;
    if (this.callback) koffi.unregister(this.callback);
    this.callback = null;
  }

  setArmed(armed) {
    this.armed = armed;
    this.lastPoint = null;
  }

  handleMouse(message, lParam) {
    const info = koffi.decode(lParam, MSLLHOOKSTRUCT);
    if (info.flags & LLMHF_INJECTED) {
      return CallNextHookEx(this.hook, 0, message, lParam);
    }

    const event = this.eventFromMessage(message, info);
    if (!event) return CallNextHookEx(this.hook, 0, message, lParam);
    if (!this.armed) return CallNextHookEx(this.hook, 0, message, lParam);

    this.onMouse({
      ...event,
      timestamp: Date.now(),
      sequence: ++this.seq
    });

    return this.suppressLocal ? 1 : CallNextHookEx(this.hook, 0, message, lParam);
  }

  eventFromMessage(message, info) {
    if (message === WM_MOUSEMOVE) {
      const point = { x: info.pt.x, y: info.pt.y };
      if (!this.lastPoint) {
        this.lastPoint = point;
        return null;
      }
      const dx = point.x - this.lastPoint.x;
      const dy = point.y - this.lastPoint.y;
      this.lastPoint = point;
      if (!dx && !dy) return null;
      return { kind: "move", dx, dy };
    }
    if (message === WM_LBUTTONDOWN || message === WM_LBUTTONUP) {
      return { kind: "button", button: "left", down: message === WM_LBUTTONDOWN };
    }
    if (message === WM_RBUTTONDOWN || message === WM_RBUTTONUP) {
      return { kind: "button", button: "right", down: message === WM_RBUTTONDOWN };
    }
    if (message === WM_MBUTTONDOWN || message === WM_MBUTTONUP) {
      return { kind: "button", button: "middle", down: message === WM_MBUTTONDOWN };
    }
    if (message === WM_MOUSEWHEEL || message === WM_MOUSEHWHEEL) {
      const delta = signedHiWord(info.mouseData);
      return { kind: "wheel", axis: message === WM_MOUSEHWHEEL ? "horizontal" : "vertical", delta };
    }
    return null;
  }
}

function signedHiWord(value) {
  const hi = (value >>> 16) & 0xffff;
  return hi & 0x8000 ? hi - 0x10000 : hi;
}

module.exports = {
  MouseHook
};
