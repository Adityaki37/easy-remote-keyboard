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

module.exports = {
  activeWindow,
  isForegroundWindow,
  sendKeyboard,
  hasKeyCode,
  sendKey
};
