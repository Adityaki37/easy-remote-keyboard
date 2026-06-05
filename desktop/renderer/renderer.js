"use strict";

const $ = (id) => document.getElementById(id);
const logBox = $("log");
let mode = "host";
let mirrorSide = "create";

function log(message) {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.prepend(line);
}

function options() {
  return {
    relayUrl: $("relayUrl").value.trim(),
    name: $("displayName").value.trim() || "Player"
  };
}

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  $(`${mode}Panel`).classList.add("active");
  $("modePill").textContent = mode === "mirror" ? "Two-way" : mode[0].toUpperCase() + mode.slice(1);
}

function setMirrorSide(nextSide) {
  mirrorSide = nextSide;
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.side === mirrorSide);
  });
}

function updateState(state) {
  if (!state) return;
  $("connectionState").textContent = state.connected ? (state.approved ? "Approved" : "Connected") : "Idle";
  if (state.targetWindow) $("targetName").textContent = state.targetWindow.title;
}

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => setMirrorSide(button.dataset.side));
});

$("lockTarget").addEventListener("click", async () => {
  try {
    const target = await window.erk.lockTarget(3000);
    $("targetName").textContent = target.title;
  } catch (err) {
    log(err.message || String(err));
  }
});

$("startHost").addEventListener("click", async () => {
  const opts = options();
  await window.erk.startHost(opts);
});

$("joinGuest").addEventListener("click", async () => {
  await window.erk.startGuest({
    ...options(),
    roomCode: $("guestRoomCode").value.trim().toUpperCase()
  });
});

$("startMirror").addEventListener("click", async () => {
  await window.erk.startMirror({
    ...options(),
    side: mirrorSide,
    roomCode: $("mirrorRoomCode").value.trim().toUpperCase()
  });
});

$("approveButton").addEventListener("click", async () => {
  await window.erk.approve();
  $("approvalBox").hidden = true;
});

$("rejectButton").addEventListener("click", async () => {
  await window.erk.reject();
  $("approvalBox").hidden = true;
});

$("pauseHost").addEventListener("click", () => window.erk.pause());
$("resumeHost").addEventListener("click", () => window.erk.resume());
$("disconnectGuest").addEventListener("click", () => window.erk.disconnect());
$("toggleGuestCapture").addEventListener("click", () => window.erk.toggleCapture());
$("toggleMirrorCapture").addEventListener("click", () => window.erk.toggleCapture());
$("stopAll").addEventListener("click", () => window.erk.stop());

window.erk.onStatus((payload) => {
  log(payload.message);
  updateState(payload.state);
  if (payload.roomCode) {
    $("hostRoomCode").textContent = payload.roomCode;
    $("mirrorCreatedCode").textContent = payload.roomCode;
  }
});

window.erk.onJoinRequest((payload) => {
  $("approvalText").textContent = `${payload.guestName} wants to connect.`;
  $("approvalBox").hidden = false;
});

window.erk.onPing((payload) => {
  $("pingValue").textContent = `${payload.ms} ms`;
});

window.erk.onInput((payload) => {
  log(`${payload.down ? "Down" : "Up"} ${payload.code}`);
});

window.erk.getState().then(updateState);
