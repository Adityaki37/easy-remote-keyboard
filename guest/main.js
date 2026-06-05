#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const WebSocket = require("ws");
const { MESSAGE_TYPES, DEFAULT_ALLOWED_CODES, sendJson, safeJsonParse } = require("../shared/protocol");
const { KeyboardHook } = require("./keyboard-hook");

const DEFAULT_RELAY_URL = process.env.RELAY_URL || "ws://localhost:8787/ws";
const DEFAULT_NAME = process.env.GUEST_NAME || process.env.USERNAME || "Friend";
const allowedCodes = parseAllowlist(process.env.ALLOW_KEYS);

let ws = null;
let hook = null;
let approved = false;
let pausedByHost = false;
let relayUrl = DEFAULT_RELAY_URL;
let roomCode = "";
let guestName = DEFAULT_NAME;
let reconnectTimer = null;
let pingTimer = null;

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

function setCapture(active, reason) {
  if (!hook) return;
  const canCapture = active && approved && !pausedByHost && ws?.readyState === WebSocket.OPEN;
  hook.setArmed(canCapture);
  if (canCapture) {
    log("Capture ACTIVE. Keys are sent to host and suppressed locally.");
  } else {
    log(`Capture inactive${reason ? ` (${reason})` : ""}.`);
  }
}

function sendInput(event) {
  sendJson(ws, {
    type: MESSAGE_TYPES.GUEST_INPUT,
    event
  });
}

function toggleCapture() {
  if (!hook) return;
  setCapture(!hook.armed, "manual toggle");
}

function connect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws = new WebSocket(relayUrl);

  ws.on("open", () => {
    log("Connected to relay. Asking host for approval...");
    sendJson(ws, {
      type: MESSAGE_TYPES.GUEST_JOIN,
      roomCode,
      guestName
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
        log(`Waiting for ${msg.hostName || "host"} to approve you.`);
      } else if (msg.status === "approved") {
        approved = true;
        pausedByHost = false;
        log("Host approved you.");
        setCapture(true);
      } else if (msg.status === "disconnected") {
        approved = false;
        setCapture(false, msg.reason || "disconnected");
      }
      return;
    }

    if (msg.type === MESSAGE_TYPES.HOST_PAUSE) {
      pausedByHost = true;
      setCapture(false, "host paused");
      return;
    }

    if (msg.type === MESSAGE_TYPES.HOST_RESUME) {
      pausedByHost = false;
      setCapture(true, "host resumed");
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_PONG) {
      process.stdout.write(`\rPing: ${Date.now() - msg.t} ms   Capture: ${hook?.armed ? "ACTIVE" : "inactive"}   `);
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_ERROR) {
      log(`Relay error: ${msg.message}`);
    }
  });

  ws.on("close", () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    approved = false;
    setCapture(false, "relay disconnected");
    log("Relay disconnected. Reconnecting in 2 seconds...");
    reconnectTimer = setTimeout(connect, 2000);
  });

  ws.on("error", (err) => {
    log(`Relay connection error: ${err.message}`);
  });
}

async function main() {
  console.clear();
  console.log("Easy Remote Keyboard Guest");
  console.log("==========================");
  console.log("This app captures your keyboard and sends it to the approved host.");
  console.log("Ctrl+Alt+F12 toggles capture. Closing this window stops everything.");
  console.log("");

  relayUrl = await ask("Relay WebSocket URL", DEFAULT_RELAY_URL);
  roomCode = (await ask("Room code")).toUpperCase();
  guestName = await ask("Your name", DEFAULT_NAME);
  if (!roomCode) throw new Error("Room code is required.");

  hook = new KeyboardHook({
    allowedCodes,
    onInput: sendInput,
    onToggle: toggleCapture
  });
  hook.start();
  log("Keyboard hook installed.");

  process.on("SIGINT", () => {
    shutdown();
  });
  process.on("exit", () => {
    if (hook) hook.stop();
  });

  connect();
}

function shutdown() {
  if (hook) hook.stop();
  if (ws) ws.close();
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
