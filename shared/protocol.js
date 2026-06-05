"use strict";

const MESSAGE_TYPES = Object.freeze({
  HOST_REGISTER: "host/register",
  HOST_APPROVE: "host/approve",
  HOST_REJECT: "host/reject",
  HOST_PAUSE: "host/pause",
  HOST_RESUME: "host/resume",
  HOST_DISCONNECT_GUEST: "host/disconnect-guest",
  HOST_INPUT: "host/input",
  HOST_MOUSE: "host/mouse",
  HOST_INPUT_ACK: "host/input-ack",
  GUEST_JOIN: "guest/join",
  GUEST_INPUT: "guest/input",
  GUEST_MOUSE: "guest/mouse",
  GUEST_INPUT_ACK: "guest/input-ack",
  GUEST_PING: "guest/ping",
  SERVER_ROOM: "server/room",
  SERVER_JOIN_REQUEST: "server/join-request",
  SERVER_GUEST_STATUS: "server/guest-status",
  SERVER_STATUS: "server/status",
  SERVER_ERROR: "server/error",
  SERVER_PONG: "server/pong"
});

const DEFAULT_ALLOWED_CODES = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "KeyQ", "KeyE", "KeyR", "KeyF", "KeyG", "KeyZ", "KeyX", "KeyC", "KeyV",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Space", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "AltLeft", "AltRight", "Tab", "Escape", "Enter", "Backspace",
  "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backquote",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"
]);

const BLOCKED_CODES = new Set([
  "MetaLeft", "MetaRight",
  "OSLeft", "OSRight",
  "PrintScreen",
  "ContextMenu",
  "Power",
  "Sleep",
  "WakeUp"
]);

const CODE_TO_VK = Object.freeze({
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Digit0: 0x30,
  Digit1: 0x31,
  Digit2: 0x32,
  Digit3: 0x33,
  Digit4: 0x34,
  Digit5: 0x35,
  Digit6: 0x36,
  Digit7: 0x37,
  Digit8: 0x38,
  Digit9: 0x39,
  KeyA: 0x41,
  KeyB: 0x42,
  KeyC: 0x43,
  KeyD: 0x44,
  KeyE: 0x45,
  KeyF: 0x46,
  KeyG: 0x47,
  KeyH: 0x48,
  KeyI: 0x49,
  KeyJ: 0x4a,
  KeyK: 0x4b,
  KeyL: 0x4c,
  KeyM: 0x4d,
  KeyN: 0x4e,
  KeyO: 0x4f,
  KeyP: 0x50,
  KeyQ: 0x51,
  KeyR: 0x52,
  KeyS: 0x53,
  KeyT: 0x54,
  KeyU: 0x55,
  KeyV: 0x56,
  KeyW: 0x57,
  KeyX: 0x58,
  KeyY: 0x59,
  KeyZ: 0x5a,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde
});

const VK_TO_CODE = Object.freeze(
  Object.fromEntries(
    Object.entries(CODE_TO_VK).map(([code, vk]) => [vk, code])
  )
);

function codeFromVk(vk, scanCode, flags) {
  if (vk === 0x10) return scanCode === 0x36 ? "ShiftRight" : "ShiftLeft";
  if (vk === 0x11) return flags & 0x01 ? "ControlRight" : "ControlLeft";
  if (vk === 0x12) return flags & 0x01 ? "AltRight" : "AltLeft";
  return VK_TO_CODE[vk] || null;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function isBlockedCombo(code, activeCodes) {
  if (BLOCKED_CODES.has(code)) return true;
  const hasCtrl = activeCodes.has("ControlLeft") || activeCodes.has("ControlRight");
  const hasAlt = activeCodes.has("AltLeft") || activeCodes.has("AltRight");
  const hasShift = activeCodes.has("ShiftLeft") || activeCodes.has("ShiftRight");

  if (hasAlt && code === "Tab") return true;
  if (hasCtrl && code === "Escape") return true;
  if (hasCtrl && hasAlt && code === "Delete") return true;
  if (hasCtrl && hasShift && code === "Escape") return true;
  return false;
}

module.exports = {
  MESSAGE_TYPES,
  DEFAULT_ALLOWED_CODES,
  BLOCKED_CODES,
  CODE_TO_VK,
  VK_TO_CODE,
  codeFromVk,
  isBlockedCombo,
  safeJsonParse,
  sendJson
};
