"use strict";

const os = require("node:os");
const koffi = require("koffi");
const { CODE_TO_VK } = require("../shared/protocol");

if (process.platform !== "win32") {
  throw new Error("The host app currently supports Windows only.");
}

if (os.arch() !== "x64") {
  throw new Error("This MVP expects 64-bit Windows/Node.");
}

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const KEYEVENTF_KEYUP = 0x0002;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x01000;

const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16",
  wScan: "uint16",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});

const INPUT_KEYBOARD = koffi.struct("INPUT_KEYBOARD", {
  type: "uint32",
  padding: "uint32",
  ki: KEYBDINPUT,
  unionPadding: koffi.array("uint8", 8)
});

const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "int32",
  dy: "int32",
  mouseData: "uint32",
  dwFlags: "uint32",
  time: "uint32",
  dwExtraInfo: "uintptr"
});

const INPUT_MOUSE = koffi.struct("INPUT_MOUSE", {
  type: "uint32",
  padding: "uint32",
  mi: MOUSEINPUT
});

const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, INPUT_KEYBOARD *pInputs, int cbSize)");
const GetForegroundWindow = user32.func("uintptr __stdcall GetForegroundWindow()");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(uintptr hWnd, _Out_ char16_t *lpString, int nMaxCount)");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(uintptr hWnd, _Out_ uint32 *lpdwProcessId)");
const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");

function hwndToString(hwnd) {
  return typeof hwnd === "bigint" ? `0x${hwnd.toString(16)}` : `0x${Number(hwnd).toString(16)}`;
}

function activeWindow() {
  const hwnd = GetForegroundWindow();
  const titleBuffer = Buffer.alloc(1024);
  let title = "";
  try {
    const length = GetWindowTextW(hwnd, titleBuffer, 512);
    title = titleBuffer.toString("utf16le", 0, Math.max(0, length) * 2);
  } catch {
    title = "";
  }
  const pidRef = [0];
  try {
    GetWindowThreadProcessId(hwnd, pidRef);
  } catch {}
  return {
    hwnd: hwndToString(hwnd),
    rawHwnd: hwnd,
    title: title || "(untitled window)",
    pid: pidRef[0] || 0
  };
}

function isForegroundWindow(rawHwnd) {
  return hwndToString(GetForegroundWindow()) === hwndToString(rawHwnd);
}

function sendKeyboard(vk, down) {
  const input = {
    type: 1,
    padding: 0,
    ki: {
      wVk: vk,
      wScan: 0,
      dwFlags: down ? 0 : KEYEVENTF_KEYUP,
      time: 0,
      dwExtraInfo: 0
    },
    unionPadding: Buffer.alloc(8)
  };
  const sent = SendInput(1, [input], koffi.sizeof(INPUT_KEYBOARD));
  if (sent !== 1) {
    const err = GetLastError();
    throw new Error(`SendInput failed; sent=${sent}, GetLastError=${err}`);
  }
}

function hasKeyCode(code) {
  return Boolean(CODE_TO_VK[code]);
}

function sendKey(code, down) {
  const vk = CODE_TO_VK[code];
  if (!vk) {
    throw new Error(`No Windows virtual-key mapping for ${code}.`);
  }
  sendKeyboard(vk, down);
}

function sendMouse(event) {
  const flagsAndData = mouseFlags(event);
  if (!flagsAndData) return;
  const input = {
    type: 0,
    padding: 0,
    mi: {
      dx: event.dx || 0,
      dy: event.dy || 0,
      mouseData: flagsAndData.mouseData,
      dwFlags: flagsAndData.flags,
      time: 0,
      dwExtraInfo: 0
    }
  };
  const sent = SendInput(1, [input], koffi.sizeof(INPUT_MOUSE));
  if (sent !== 1) {
    const err = GetLastError();
    throw new Error(`SendInput mouse failed; sent=${sent}, GetLastError=${err}`);
  }
}

function mouseFlags(event) {
  if (!event || typeof event.kind !== "string") return null;
  if (event.kind === "move") {
    if (!event.dx && !event.dy) return null;
    return { flags: MOUSEEVENTF_MOVE, mouseData: 0 };
  }
  if (event.kind === "wheel") {
    return { flags: event.axis === "horizontal" ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, mouseData: event.delta >>> 0 };
  }
  if (event.kind === "button") {
    const down = Boolean(event.down);
    if (event.button === "left") return { flags: down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP, mouseData: 0 };
    if (event.button === "right") return { flags: down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP, mouseData: 0 };
    if (event.button === "middle") return { flags: down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP, mouseData: 0 };
  }
  return null;
}

module.exports = {
  activeWindow,
  isForegroundWindow,
  sendKeyboard,
  hasKeyCode,
  sendKey,
  sendMouse
};
