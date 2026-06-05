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
const input = require("../host/platform");
const { KeyboardHook } = require("../guest/keyboard-hook");

const DEFAULT_RELAY_URL = process.env.RELAY_URL || "ws://localhost:8787/ws";
const DEFAULT_NAME = process.env.ERK_NAME || process.env.HOST_NAME || process.env.GUEST_NAME || process.env.USERNAME || "Player";
const allowedCodes = parseAllowlist(process.env.ALLOW_KEYS);

let ws = null;
let hook = null;
let targetWindow = null;
let relayUrl = DEFAULT_RELAY_URL;
let localName = DEFAULT_NAME;
let roomCode = "";
let side = "";
let approved = false;
let captureOn = false;
let reconnectTimer = null;
let pingTimer = null;
let lastRemoteInputAt = 0;

const remoteHeldCodes = new Set();
const remoteActiveCodes = new Set();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function parseAllowlist(value) {
  if (!value) return new Set(DEFAULT_ALLOWED_CODES);
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function ask(question, fallback) {
  return new Promise((resolve) => {
    const suffix = fallback ? ` (${fallback})` : "";
    rl.question(`${question}${suffix}: `, (answer) => resolve(answer.trim() || fallback || ""));
  });
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function localInputType() {
  return side === "create" ? MESSAGE_TYPES.HOST_INPUT : MESSAGE_TYPES.GUEST_INPUT;
}

function remoteInputType() {
  return side === "create" ? MESSAGE_TYPES.GUEST_INPUT : MESSAGE_TYPES.HOST_INPUT;
}

function setCapture(active, reason) {
  captureOn = Boolean(active && approved && ws?.readyState === WebSocket.OPEN);
  if (hook) hook.setArmed(captureOn);
  log(`Two-way capture ${captureOn ? "ACTIVE" : "inactive"}${reason ? ` (${reason})` : ""}.`);
}

function toggleCapture() {
  setCapture(!captureOn, "manual toggle");
}

function sendLocalInput(event) {
  sendJson(ws, {
    type: localInputType(),
    event: {
      ...event,
      origin: side,
      mirrored: true
    }
  });
}

function releaseRemote(reason) {
  for (const code of [...remoteHeldCodes]) {
    if (input.hasKeyCode(code)) {
      try {
        if (hook?.ignoreNext) hook.ignoreNext(code, false);
        input.sendKey(code, false);
      } catch (err) {
        log(`Failed to release remote ${code}: ${err.message}`);
      }
    }
    remoteHeldCodes.delete(code);
  }
  remoteActiveCodes.clear();
  if (reason) log(`Released remote keys (${reason}).`);
}

function validateRemote(event) {
  if (!event || typeof event.code !== "string" || typeof event.down !== "boolean") {
    return "Malformed remote input event.";
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
  return null;
}

function injectRemote(event) {
  const before = new Set(remoteActiveCodes);
  if (event.down) remoteActiveCodes.add(event.code);
  else remoteActiveCodes.delete(event.code);

  const failure = validateRemote(event);
  if (failure) {
    remoteActiveCodes.clear();
    for (const code of before) remoteActiveCodes.add(code);
    if (event.down) log(failure);
    releaseRemote("blocked or unsafe remote input");
    return;
  }

  if (event.down) {
    if (remoteHeldCodes.has(event.code)) return;
    remoteHeldCodes.add(event.code);
  } else {
    if (!remoteHeldCodes.has(event.code)) return;
    remoteHeldCodes.delete(event.code);
  }

  try {
    if (hook?.ignoreNext) hook.ignoreNext(event.code, event.down);
    input.sendKey(event.code, event.down);
    lastRemoteInputAt = Date.now();
  } catch (err) {
    log(err.message);
    releaseRemote("input injection error");
  }
}

function connectAsCreator() {
  ws = new WebSocket(relayUrl);

  ws.on("open", () => {
    sendJson(ws, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: `${localName} (two-way)` });
  });

  ws.on("message", async (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.SERVER_ROOM) {
      log("Two-way room ready.");
      log(`Room code: ${msg.roomCode}`);
      log("Waiting for the other player to join...");
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_JOIN_REQUEST) {
      releaseRemote("new join request");
      log(`${msg.guestName} wants to join two-way mode.`);
      const answer = (await ask("Approve this player? Type y and Enter")).toLowerCase();
      if (answer === "y" || answer === "yes") {
        approved = true;
        sendJson(ws, { type: MESSAGE_TYPES.HOST_APPROVE });
        setCapture(true, "peer approved");
      } else {
        sendJson(ws, { type: MESSAGE_TYPES.HOST_REJECT });
      }
      return;
    }

    handleCommonMessage(msg);
  });

  attachCommonSocketHandlers();
}

function connectAsJoiner() {
  ws = new WebSocket(relayUrl);

  ws.on("open", () => {
    sendJson(ws, {
      type: MESSAGE_TYPES.GUEST_JOIN,
      roomCode,
      guestName: `${localName} (two-way)`
    });
    pingTimer = setInterval(() => {
      sendJson(ws, { type: MESSAGE_TYPES.GUEST_PING, t: Date.now() });
    }, 1000);
  });

  ws.on("message", (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      if (msg.status === "waiting-approval") {
        log(`Waiting for ${msg.hostName || "the creator"} to approve you.`);
      } else if (msg.status === "approved") {
        approved = true;
        setCapture(true, "approved");
      } else if (msg.status === "disconnected") {
        approved = false;
        setCapture(false, msg.reason || "disconnected");
        releaseRemote("peer disconnected");
      }
      return;
    }

    handleCommonMessage(msg);
  });

  attachCommonSocketHandlers();
}

function handleCommonMessage(msg) {
  if (msg.type === remoteInputType()) {
    injectRemote(msg.event);
    return;
  }

  if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS && msg.status === "guest-disconnected") {
    approved = false;
    setCapture(false, "peer disconnected");
    releaseRemote("peer disconnected");
    return;
  }

  if (msg.type === MESSAGE_TYPES.SERVER_PONG) {
    process.stdout.write(`\rPing: ${Date.now() - msg.t} ms   Two-way: ${captureOn ? "ACTIVE" : "inactive"}   `);
    return;
  }

  if (msg.type === MESSAGE_TYPES.SERVER_ERROR) {
    log(`Relay error: ${msg.message}`);
  }
}

function attachCommonSocketHandlers() {
  ws.on("close", () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    approved = false;
    setCapture(false, "relay disconnected");
    releaseRemote("relay disconnected");
    log("Relay disconnected. Reconnecting in 2 seconds...");
    reconnectTimer = setTimeout(() => {
      if (side === "create") connectAsCreator();
      else connectAsJoiner();
    }, 2000);
  });

  ws.on("error", (err) => {
    log(`Relay connection error: ${err.message}`);
  });
}

async function main() {
  console.clear();
  console.log("Easy Remote Keyboard - Two-Way Mode");
  console.log("===================================");
  console.log("Both computers keep their own local keyboard input and also send it to the other computer.");
  console.log("Ctrl+Alt+F12 toggles sending your local keys to the other computer.");
  console.log("");

  side = (await ask("Create room or join room? Type create/join", "create")).toLowerCase();
  if (side !== "create" && side !== "join") {
    throw new Error("Choose create or join.");
  }
  relayUrl = await ask("Relay WebSocket URL", DEFAULT_RELAY_URL);
  localName = await ask("Your name", DEFAULT_NAME);
  if (side === "join") {
    roomCode = (await ask("Room code")).toUpperCase();
    if (!roomCode) throw new Error("Room code is required.");
  }

  await ask("Open/focus the local app or game you want mirrored, then press Enter here");
  targetWindow = input.activeWindow();
  log(`Target locked: ${targetWindow.title}`);
  log(`Target ID ${targetWindow.hwnd}, PID ${targetWindow.pid}`);

  hook = new KeyboardHook({
    allowedCodes,
    suppressLocal: false,
    onInput: sendLocalInput,
    onToggle: toggleCapture
  });
  hook.start();
  log("Local keyboard mirror hook installed.");

  process.stdin.on("data", (chunk) => {
    const command = chunk.toString().trim().toLowerCase();
    if (command === "c") toggleCapture();
    if (command === "q") shutdown();
  });

  setInterval(() => {
    if (remoteHeldCodes.size && Date.now() - lastRemoteInputAt > 3000) {
      releaseRemote("stuck-key watchdog");
    }
    if (remoteHeldCodes.size && targetWindow && !input.isForegroundWindow(targetWindow.rawHwnd)) {
      releaseRemote("target lost focus");
    }
  }, 250).unref();

  process.on("SIGINT", shutdown);
  process.on("exit", () => {
    if (hook) hook.stop();
  });

  if (side === "create") connectAsCreator();
  else connectAsJoiner();
}

function shutdown() {
  releaseRemote("quit");
  if (hook) hook.stop();
  if (ws) ws.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    if (hook) hook.stop();
    process.exit(1);
  });
}

module.exports = {
  main
};
