"use strict";

const { spawnSync } = require("node:child_process");
const koffi = require("koffi");

if (process.platform !== "darwin") {
  throw new Error("The macOS host module can only run on macOS.");
}

const APPLICATION_SERVICES = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const CORE_FOUNDATION = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const appServices = koffi.load(APPLICATION_SERVICES);
const coreFoundation = koffi.load(CORE_FOUNDATION);

const kCGHIDEventTap = 0;

const CGEventCreateKeyboardEvent = appServices.func("uintptr CGEventCreateKeyboardEvent(uintptr source, uint16 virtualKey, bool keyDown)");
const CGEventPost = appServices.func("void CGEventPost(uint32 tap, uintptr event)");
const CFRelease = coreFoundation.func("void CFRelease(uintptr cf)");

const CODE_TO_MAC_KEY = Object.freeze({
  KeyA: 0x00,
  KeyS: 0x01,
  KeyD: 0x02,
  KeyF: 0x03,
  KeyH: 0x04,
  KeyG: 0x05,
  KeyZ: 0x06,
  KeyX: 0x07,
  KeyC: 0x08,
  KeyV: 0x09,
  KeyB: 0x0b,
  KeyQ: 0x0c,
  KeyW: 0x0d,
  KeyE: 0x0e,
  KeyR: 0x0f,
  KeyY: 0x10,
  KeyT: 0x11,
  Digit1: 0x12,
  Digit2: 0x13,
  Digit3: 0x14,
  Digit4: 0x15,
  Digit6: 0x16,
  Digit5: 0x17,
  Equal: 0x18,
  Digit9: 0x19,
  Digit7: 0x1a,
  Minus: 0x1b,
  Digit8: 0x1c,
  Digit0: 0x1d,
  BracketRight: 0x1e,
  KeyO: 0x1f,
  KeyU: 0x20,
  BracketLeft: 0x21,
  KeyI: 0x22,
  KeyP: 0x23,
  Enter: 0x24,
  KeyL: 0x25,
  KeyJ: 0x26,
  Quote: 0x27,
  KeyK: 0x28,
  Semicolon: 0x29,
  Backslash: 0x2a,
  Comma: 0x2b,
  Slash: 0x2c,
  KeyN: 0x2d,
  KeyM: 0x2e,
  Period: 0x2f,
  Tab: 0x30,
  Space: 0x31,
  Backquote: 0x32,
  Backspace: 0x33,
  Escape: 0x35,
  ControlLeft: 0x3b,
  ShiftLeft: 0x38,
  ShiftRight: 0x3c,
  AltLeft: 0x3a,
  AltRight: 0x3d,
  ControlRight: 0x3e,
  F1: 0x7a,
  F2: 0x78,
  F3: 0x63,
  F4: 0x76,
  F5: 0x60,
  F6: 0x61,
  F7: 0x62,
  F8: 0x64,
  F9: 0x65,
  F10: 0x6d,
  F11: 0x67,
  F12: 0x6f,
  Home: 0x73,
  PageUp: 0x74,
  Delete: 0x75,
  End: 0x77,
  PageDown: 0x79,
  ArrowLeft: 0x7b,
  ArrowRight: 0x7c,
  ArrowDown: 0x7d,
  ArrowUp: 0x7e
});

let cachedFrontmost = null;
let cachedAt = 0;

function frontmostApp() {
  const now = Date.now();
  if (cachedFrontmost && now - cachedAt < 125) {
    return cachedFrontmost;
  }

  const script = [
    'tell application "System Events"',
    'set frontApp to first application process whose frontmost is true',
    'return (unix id of frontApp as text) & tab & (name of frontApp as text)',
    "end tell"
  ].join("\n");

  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 1500
  });

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new Error(`Could not read the frontmost macOS app. Grant Accessibility permission. ${message}`);
  }

  const [pidRaw, ...nameParts] = result.stdout.trim().split("\t");
  cachedFrontmost = {
    pid: Number(pidRaw) || 0,
    title: nameParts.join("\t") || "(frontmost app)"
  };
  cachedAt = now;
  return cachedFrontmost;
}

function activeWindow() {
  const app = frontmostApp();
  return {
    hwnd: `pid:${app.pid}`,
    rawHwnd: app.pid,
    title: app.title,
    pid: app.pid
  };
}

function isForegroundWindow(rawPid) {
  return frontmostApp().pid === Number(rawPid);
}

function hasKeyCode(code) {
  return Object.prototype.hasOwnProperty.call(CODE_TO_MAC_KEY, code);
}

function sendKey(code, down) {
  const keyCode = CODE_TO_MAC_KEY[code];
  if (keyCode == null) {
    throw new Error(`No macOS key-code mapping for ${code}.`);
  }

  const event = CGEventCreateKeyboardEvent(0, keyCode, down);
  if (!event) {
    throw new Error("CGEventCreateKeyboardEvent failed. Grant Accessibility permission.");
  }
  try {
    CGEventPost(kCGHIDEventTap, event);
  } finally {
    CFRelease(event);
  }
}

module.exports = {
  activeWindow,
  isForegroundWindow,
  hasKeyCode,
  sendKey,
  CODE_TO_MAC_KEY
};
