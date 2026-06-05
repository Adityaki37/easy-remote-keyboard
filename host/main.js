#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const WebSocket = require("ws");
const {
  MESSAGE_TYPES,
  DEFAULT_ALLOWED_CODES,
  isBlockedCombo,
  safeJsonParse,
  sendJson
} = require("../shared/protocol");
const input = require("./platform");

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:8787/ws";
const HOST_NAME = process.env.HOST_NAME || `${process.env.USERNAME || "Windows"}'s PC`;
const allowedCodes = parseAllowlist(process.env.ALLOW_KEYS);
const heldCodes = new Set();
const remoteActiveCodes = new Set();

let ws;
let targetWindow = null;
let paused = false;
let approvedGuest = null;
let lastInputAt = 0;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function parseAllowlist(value) {
  if (!value) return new Set(DEFAULT_ALLOWED_CODES);
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function releaseAll(reason) {
  for (const code of [...heldCodes]) {
    if (input.hasKeyCode(code)) {
      try {
        input.sendKey(code, false);
      } catch (err) {
        log(`Failed to release ${code}: ${err.message}`);
      }
    }
    heldCodes.delete(code);
  }
  remoteActiveCodes.clear();
  if (reason) log(`Released all remote keys (${reason}).`);
}

function pause(reason) {
  paused = true;
  releaseAll(reason || "paused");
  sendJson(ws, { type: MESSAGE_TYPES.HOST_PAUSE });
  log("Remote input paused. Type r + Enter to resume.");
}

function resume() {
  paused = false;
  sendJson(ws, { type: MESSAGE_TYPES.HOST_RESUME });
  log("Remote input resumed.");
}

function disconnectGuest() {
  releaseAll("guest disconnected");
  approvedGuest = null;
  sendJson(ws, { type: MESSAGE_TYPES.HOST_DISCONNECT_GUEST });
}

function validateEvent(event) {
  if (!event || typeof event.code !== "string" || typeof event.down !== "boolean") {
    return "Malformed input event.";
  }
  if (!allowedCodes.has(event.code)) {
    return `Blocked ${event.code}; it is not in the allowlist.`;
  }
  if (isBlockedCombo(event.code, remoteActiveCodes)) {
    return `Blocked dangerous combo involving ${event.code}.`;
  }
  if (!input.hasKeyCode(event.code)) {
    return `No ${process.platform} key mapping for ${event.code}.`;
  }
  if (!targetWindow || !input.isForegroundWindow(targetWindow.rawHwnd)) {
    return "Target window is not foreground.";
  }
  if (paused) {
    return "Host is paused.";
  }
  return null;
}

function handleInput(event) {
  const before = new Set(remoteActiveCodes);
  if (event.down) remoteActiveCodes.add(event.code);
  else remoteActiveCodes.delete(event.code);

  const failure = validateEvent(event);
  if (failure) {
    remoteActiveCodes.clear();
    for (const code of before) remoteActiveCodes.add(code);
    if (event.down) log(failure);
    releaseAll("blocked or unsafe input");
    return;
  }

  try {
    if (event.down) heldCodes.add(event.code);
    else heldCodes.delete(event.code);
    input.sendKey(event.code, event.down);
    lastInputAt = Date.now();
  } catch (err) {
    log(err.message);
    releaseAll("input injection error");
  }
}

function connect() {
  ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    sendJson(ws, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: HOST_NAME });
  });

  ws.on("message", async (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.SERVER_ROOM) {
      log(`Session ready.`);
      log(`Room code: ${msg.roomCode}`);
      log(`Share link: ${msg.shareUrl}`);
      log("Waiting for friend to join...");
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_JOIN_REQUEST) {
      releaseAll("new join request");
      log(`${msg.guestName} wants to connect.`);
      const answer = (await ask("Approve this friend? Type y and Enter: ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        approvedGuest = msg.guestName;
        sendJson(ws, { type: MESSAGE_TYPES.HOST_APPROVE });
        log(`Approved ${msg.guestName}.`);
      } else {
        sendJson(ws, { type: MESSAGE_TYPES.HOST_REJECT });
        log("Rejected guest.");
      }
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      if (msg.status === "guest-disconnected") {
        releaseAll("guest disconnected");
        approvedGuest = null;
        log("Friend disconnected.");
      } else if (msg.status === "approved") {
        log(`Remote keyboard active for ${msg.guestName || approvedGuest || "friend"}.`);
      }
      return;
    }

    if (msg.type === MESSAGE_TYPES.GUEST_INPUT) {
      handleInput(msg.event);
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_ERROR) {
      log(`Relay error: ${msg.message}`);
    }
  });

  ws.on("close", () => {
    releaseAll("relay disconnected");
    log("Relay disconnected. Reconnecting in 2 seconds...");
    setTimeout(connect, 2000);
  });

  ws.on("error", (err) => {
    log(`Relay connection error: ${err.message}`);
  });
}

async function main() {
  console.clear();
  console.log("Easy Remote Keyboard Host");
  console.log("=========================");
  console.log("Safety: remote keys only inject while your selected target window is foreground.");
  console.log("Commands after start: p = pause, r = resume, d = disconnect friend, q = quit.");
  console.log("");

  await ask("Open/focus the app or game you want to control, then press Enter here.");
  targetWindow = input.activeWindow();
  console.log("");
  log(`Target locked: ${targetWindow.title}`);
  log(`HWND ${targetWindow.hwnd}, PID ${targetWindow.pid}`);
  console.log("");

  process.stdin.on("data", (chunk) => {
    const command = chunk.toString().trim().toLowerCase();
    if (command === "p") pause("manual pause");
    if (command === "r") resume();
    if (command === "d") disconnectGuest();
    if (command === "q") {
      releaseAll("quit");
      process.exit(0);
    }
  });

  setInterval(() => {
    if (heldCodes.size && Date.now() - lastInputAt > 3000) {
      releaseAll("stuck-key watchdog");
    }
    if (heldCodes.size && targetWindow && !input.isForegroundWindow(targetWindow.rawHwnd)) {
      releaseAll("target lost focus");
    }
  }, 250).unref();

  process.on("SIGINT", () => {
    releaseAll("Ctrl+C");
    process.exit(0);
  });

  connect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    releaseAll("fatal error");
    process.exit(1);
  });
}

module.exports = {
  main
};
