"use strict";

const assert = require("node:assert/strict");
const { CODE_TO_VK, DEFAULT_ALLOWED_CODES, MESSAGE_TYPES, codeFromVk, isBlockedCombo } = require("../shared/protocol");

assert.equal(CODE_TO_VK.KeyW, 0x57);
assert.equal(CODE_TO_VK.Space, 0x20);
assert.equal(DEFAULT_ALLOWED_CODES.has("KeyW"), true);
assert.equal(isBlockedCombo("MetaLeft", new Set()), true);
assert.equal(isBlockedCombo("Tab", new Set(["AltLeft"])), true);
assert.equal(isBlockedCombo("Escape", new Set(["ControlLeft"])), true);
assert.equal(isBlockedCombo("KeyW", new Set(["ShiftLeft"])), false);
assert.equal(codeFromVk(0x57, 17, 0), "KeyW");
assert.equal(codeFromVk(0x10, 0x36, 0), "ShiftRight");
assert.equal(codeFromVk(0x11, 0x1d, 0x01), "ControlRight");
assert.equal(MESSAGE_TYPES.HOST_INPUT, "host/input");
assert.equal(MESSAGE_TYPES.HOST_INPUT_ACK, "host/input-ack");
assert.equal(MESSAGE_TYPES.GUEST_MOUSE, "guest/mouse");
assert.equal(MESSAGE_TYPES.GUEST_INPUT_ACK, "guest/input-ack");

console.log("Smoke tests passed.");
