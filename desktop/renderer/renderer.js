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
  const transportMode = $("transportMode").value;
  return {
    transportMode,
    relayUrl: $("relayUrl").value.trim(),
    directHost: $("directHost").value.trim(),
    directPort: Number($("directPort").value) || 8788,
    udpPort: Number($("udpPort").value) || 8789,
    name: $("displayName").value.trim() || "Player",
    mouseEnabled: $("enableMouse").checked
  };
}

function updateTransportFields() {
  const transportMode = $("transportMode").value;
  document.querySelectorAll("[data-transport-field]").forEach((field) => {
    const group = field.dataset.transportField;
    field.hidden = (group === "relay" && transportMode !== "relay") ||
      (group === "direct" && transportMode === "relay") ||
      (group === "udp" && transportMode !== "direct-udp");
  });
  if (transportMode === "relay") {
    $("transportHint").textContent = "Relay uses the WebSocket URL and works over the internet when the relay is hosted.";
  } else if (transportMode === "direct-tcp") {
    $("transportHint").textContent = "Host listens on TCP. Guest connects to the host IP over LAN, VPN, or port-forwarding.";
  } else {
    $("transportHint").textContent = "TCP handles approval; keyboard/mouse packets use UDP for lower latency on LAN/VPN.";
  }
  $("transportState").textContent = transportLabel(transportMode);
}

function transportLabel(transportMode) {
  if (transportMode === "direct-tcp") return "Direct TCP";
  if (transportMode === "direct-udp") return "Direct UDP";
  return "Relay";
}

function isLocalHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return !host || host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function warnIfDirectJoin(opts) {
  if (opts.transportMode === "relay") return;
  if (isLocalHost(opts.directHost)) {
    log("Direct host is localhost. On another computer, replace it with the host PC/Mac IP shown on the creator side.");
  }
}

function showConnectionInfo(text) {
  if (!text) return;
  for (const id of ["hostConnectionInfo", "mirrorConnectionInfo"]) {
    const el = $(id);
    el.textContent = `Give this to the other computer: ${text}`;
    el.hidden = false;
  }
  log(`Connection info: ${text}`);
}

function clearConnectionInfo() {
  for (const id of ["hostConnectionInfo", "mirrorConnectionInfo"]) {
    const el = $(id);
    el.textContent = "";
    el.hidden = true;
  }
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
  $("transportState").textContent = transportLabel(state.transportMode || $("transportMode").value);
  $("mouseState").textContent = state.mouseEnabled || state.receiveMouse ? "On" : "Off";
  if (state.targetWindow) $("targetName").textContent = state.targetWindow.title;
}

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => setMirrorSide(button.dataset.side));
});

$("transportMode").addEventListener("change", updateTransportFields);

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
  clearConnectionInfo();
  await window.erk.startHost(opts);
});

$("joinGuest").addEventListener("click", async () => {
  const opts = {
    ...options(),
    roomCode: $("guestRoomCode").value.trim().toUpperCase()
  };
  warnIfDirectJoin(opts);
  await window.erk.startGuest(opts);
});

$("startMirror").addEventListener("click", async () => {
  const opts = {
    ...options(),
    side: mirrorSide,
    roomCode: $("mirrorRoomCode").value.trim().toUpperCase()
  };
  if (mirrorSide === "create") clearConnectionInfo();
  else warnIfDirectJoin(opts);
  await window.erk.startMirror(opts);
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
  if (payload.shareUrl) showConnectionInfo(payload.shareUrl);
});

window.erk.onJoinRequest((payload) => {
  $("approvalText").textContent = `${payload.guestName} wants to connect.`;
  $("approvalBox").hidden = false;
});

window.erk.onPing((payload) => {
  if (payload.kind === "input") {
    const prefix = payload.inputKind === "mouse" ? "mouse" : "key";
    $("inputLagValue").textContent = `${prefix} ${payload.ms} ms${payload.ok ? "" : " blocked"}`;
    return;
  }
  $("pingValue").textContent = `${payload.ms} ms`;
});

window.erk.onInput((payload) => {
  log(`${payload.down ? "Down" : "Up"} ${payload.code}`);
});

window.erk.getState().then(updateState);
updateTransportFields();
