"use strict";

const MESSAGE_TYPES = {
  GUEST_JOIN: "guest/join",
  GUEST_INPUT: "guest/input",
  GUEST_PING: "guest/ping",
  SERVER_GUEST_STATUS: "server/guest-status",
  SERVER_ERROR: "server/error",
  SERVER_PONG: "server/pong",
  HOST_PAUSE: "host/pause",
  HOST_RESUME: "host/resume"
};

const params = new URLSearchParams(window.location.search);
const roomInput = document.getElementById("roomCode");
const nameInput = document.getElementById("guestName");
const joinForm = document.getElementById("joinForm");
const captureButton = document.getElementById("captureButton");
const releaseButton = document.getElementById("releaseButton");
const captureSurface = document.getElementById("captureSurface");
const statusBadge = document.getElementById("statusBadge");
const connState = document.getElementById("connState");
const pingValue = document.getElementById("pingValue");
const heldCount = document.getElementById("heldCount");
const surfaceTitle = document.getElementById("surfaceTitle");
const surfaceHint = document.getElementById("surfaceHint");
const logBox = document.getElementById("log");

roomInput.value = (params.get("room") || "").toUpperCase();
nameInput.value = localStorage.getItem("erkGuestName") || "";

let ws;
let approved = false;
let capturing = false;
let seq = 0;
let pingTimer;
const held = new Set();

function log(message) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.prepend(line);
}

function setStatus(text, mode) {
  statusBadge.textContent = text;
  statusBadge.className = `badge ${mode || ""}`;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function connect(roomCode, guestName) {
  if (ws) ws.close();
  ws = new WebSocket(wsUrl());
  approved = false;
  captureButton.disabled = true;
  connState.textContent = "connecting";
  setStatus("Joining", "warn");

  ws.addEventListener("open", () => {
    send({ type: MESSAGE_TYPES.GUEST_JOIN, roomCode, guestName });
    localStorage.setItem("erkGuestName", guestName);
    startPing();
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      handleGuestStatus(msg);
    } else if (msg.type === MESSAGE_TYPES.SERVER_ERROR) {
      log(msg.message);
      connState.textContent = "error";
      setStatus("Error", "warn");
    } else if (msg.type === MESSAGE_TYPES.SERVER_PONG) {
      pingValue.textContent = `${Date.now() - msg.t} ms`;
    } else if (msg.type === MESSAGE_TYPES.HOST_PAUSE) {
      log("Host paused input.");
      releaseCapture();
      captureButton.disabled = true;
    } else if (msg.type === MESSAGE_TYPES.HOST_RESUME) {
      log("Host resumed input.");
      captureButton.disabled = !approved;
    }
  });

  ws.addEventListener("close", () => {
    stopPing();
    releaseCapture();
    approved = false;
    connState.textContent = "disconnected";
    setStatus("Offline", "warn");
  });
}

function handleGuestStatus(msg) {
  if (msg.status === "waiting-approval") {
    connState.textContent = "waiting for host";
    setStatus("Waiting", "warn");
    log(`Connected. Waiting for ${msg.hostName || "host"} approval.`);
    return;
  }
  if (msg.status === "approved") {
    approved = true;
    captureButton.disabled = false;
    connState.textContent = "approved";
    setStatus("Ready", "");
    log("Host approved you. Click Capture Keyboard.");
    return;
  }
  if (msg.status === "disconnected") {
    log(msg.reason || "Disconnected.");
    releaseCapture();
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    send({ type: MESSAGE_TYPES.GUEST_PING, t: Date.now() });
  }, 1000);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

async function captureKeyboard() {
  if (!approved) return;
  try {
    await captureSurface.requestFullscreen();
  } catch {
    log("Fullscreen was not allowed. Click the capture area and try again.");
  }
  if (navigator.keyboard?.lock) {
    try {
      await navigator.keyboard.lock();
      log("Keyboard Lock enabled.");
    } catch {
      log("Keyboard Lock unavailable or denied; normal key capture still works for most keys.");
    }
  }
  capturing = true;
  captureSurface.focus();
  captureSurface.classList.add("active");
  captureButton.disabled = true;
  releaseButton.disabled = false;
  surfaceTitle.textContent = "Keyboard capture active";
  surfaceHint.textContent = "Keep this tab focused. Hold Esc for browser escape if keyboard lock is active.";
  setStatus("Live", "live");
}

function releaseCapture() {
  for (const code of [...held]) {
    sendKey(code, false, 0);
  }
  held.clear();
  heldCount.textContent = "0";
  capturing = false;
  captureSurface.classList.remove("active");
  captureButton.disabled = !approved;
  releaseButton.disabled = true;
  surfaceTitle.textContent = "Keyboard capture inactive";
  surfaceHint.textContent = "Click Capture Keyboard to resume.";
  if (navigator.keyboard?.unlock) navigator.keyboard.unlock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (approved) setStatus("Ready", "");
}

function sendKey(code, down, location) {
  send({
    type: MESSAGE_TYPES.GUEST_INPUT,
    event: {
      code,
      down,
      location,
      timestamp: Date.now(),
      sequence: ++seq
    }
  });
}

function onKey(event, down) {
  if (!capturing) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.code || event.repeat) return;

  if (down) {
    if (held.has(event.code)) return;
    held.add(event.code);
  } else {
    if (!held.has(event.code)) return;
    held.delete(event.code);
  }
  heldCount.textContent = String(held.size);
  sendKey(event.code, down, event.location || 0);
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const roomCode = roomInput.value.trim().toUpperCase();
  const guestName = nameInput.value.trim() || "Friend";
  if (!roomCode) return;
  connect(roomCode, guestName);
});

captureButton.addEventListener("click", captureKeyboard);
releaseButton.addEventListener("click", releaseCapture);
window.addEventListener("keydown", (event) => onKey(event, true), { capture: true });
window.addEventListener("keyup", (event) => onKey(event, false), { capture: true });
window.addEventListener("blur", releaseCapture);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && capturing) releaseCapture();
});
