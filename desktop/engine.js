"use strict";

const { EventEmitter } = require("node:events");
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
const { MouseHook } = require("../guest/mouse-hook");
const { createTransport } = require("./transports");

function parseAllowlist(value) {
  if (!value) return new Set(DEFAULT_ALLOWED_CODES);
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

class DesktopEngine extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.hook = null;
    this.mouseHook = null;
    this.role = null;
    this.side = null;
    this.transportMode = "relay";
    this.targetWindow = null;
    this.paused = false;
    this.approved = false;
    this.captureOn = false;
    this.mouseEnabled = false;
    this.receiveMouse = false;
    this.remoteHeldCodes = new Set();
    this.remoteMouseButtons = new Set();
    this.remoteActiveCodes = new Set();
    this.pendingInputAcks = new Map();
    this.allowedCodes = parseAllowlist(process.env.ALLOW_KEYS);
    this.lastRemoteInputAt = 0;
    this.nextLatencyId = 0;
    this.pingTimer = null;
    this.watchdog = setInterval(() => this.watchdogTick(), 250);
    this.watchdog.unref();
  }

  snapshot() {
    return {
      role: this.role,
      side: this.side,
      targetWindow: this.targetWindow,
      connected: this.ws?.readyState === WebSocket.OPEN,
      approved: this.approved,
      paused: this.paused,
      captureOn: this.captureOn,
      transportMode: this.transportMode,
      mouseEnabled: this.mouseEnabled,
      receiveMouse: this.receiveMouse,
      remoteHeld: this.remoteHeldCodes.size
    };
  }

  emitStatus(message, extra = {}) {
    this.emit("status", {
      message,
      state: this.snapshot(),
      ...extra,
      at: Date.now()
    });
  }

  async lockTarget(delayMs = 3000) {
    this.emitStatus(`Switch to the target app. Locking in ${Math.ceil(delayMs / 1000)} seconds...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.targetWindow = input.activeWindow();
    this.emitStatus(`Target locked: ${this.targetWindow.title}`, { targetWindow: this.targetWindow });
    return this.targetWindow;
  }

  startHost({ relayUrl, name, mouseEnabled = false, transportMode = "relay", directHost, directPort, udpPort }) {
    this.stop({ silent: true });
    this.role = "host";
    this.side = "create";
    this.transportMode = transportMode;
    this.paused = false;
    this.approved = false;
    this.mouseEnabled = false;
    this.receiveMouse = Boolean(mouseEnabled);
    this.ws = createTransport({ transportMode, relayUrl, directHost, directPort, udpPort, role: "host", side: "create", name });

    this.ws.on("open", () => {
      sendJson(this.ws, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: name || "Host" });
      this.emitStatus(`${transportLabel(transportMode)} ready. Creating host room...`);
    });

    this.ws.on("message", (raw) => this.handleHostMessage(raw));
    this.attachCommonSocketHandlers();
  }

  handleHostMessage(raw) {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.SERVER_ROOM) {
      this.emitStatus("Host room ready.", { roomCode: msg.roomCode, shareUrl: msg.shareUrl });
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_JOIN_REQUEST) {
      this.releaseRemote("new join request");
      this.emit("join-request", { guestName: msg.guestName });
      this.emitStatus(`${msg.guestName} wants to connect.`);
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      if (msg.status === "approved") {
        this.approved = true;
        this.emitStatus(`Remote keyboard active for ${msg.guestName || "guest"}.`);
      } else if (msg.status === "guest-disconnected") {
        this.approved = false;
        this.releaseRemote("guest disconnected");
        this.emitStatus("Guest disconnected.");
      }
      return;
    }

    if (msg.type === MESSAGE_TYPES.GUEST_INPUT) {
      const ok = this.injectRemote(msg.event);
      this.sendInputAck(MESSAGE_TYPES.HOST_INPUT_ACK, msg, ok);
      return;
    }

    if (msg.type === MESSAGE_TYPES.GUEST_MOUSE) {
      const ok = this.injectRemoteMouse(msg.event);
      this.sendInputAck(MESSAGE_TYPES.HOST_INPUT_ACK, msg, ok);
      return;
    }

    this.handleCommonMessage(msg);
  }

  approveGuest() {
    this.approved = true;
    sendJson(this.ws, { type: MESSAGE_TYPES.HOST_APPROVE });
    this.emitStatus("Guest approved.");
  }

  rejectGuest() {
    sendJson(this.ws, { type: MESSAGE_TYPES.HOST_REJECT });
    this.emitStatus("Guest rejected.");
  }

  pauseHost() {
    this.paused = true;
    this.releaseRemote("paused");
    sendJson(this.ws, { type: MESSAGE_TYPES.HOST_PAUSE });
    this.emitStatus("Remote input paused.");
  }

  resumeHost() {
    this.paused = false;
    sendJson(this.ws, { type: MESSAGE_TYPES.HOST_RESUME });
    this.emitStatus("Remote input resumed.");
  }

  disconnectGuest() {
    this.releaseRemote("guest disconnected");
    this.approved = false;
    sendJson(this.ws, { type: MESSAGE_TYPES.HOST_DISCONNECT_GUEST });
    this.emitStatus("Guest disconnected.");
  }

  startGuest({ relayUrl, roomCode, name, mouseEnabled = false, transportMode = "relay", directHost, directPort, udpPort }) {
    this.stop({ silent: true });
    this.role = "guest";
    this.side = "join";
    this.transportMode = transportMode;
    this.approved = false;
    this.paused = false;
    this.mouseEnabled = Boolean(mouseEnabled);
    this.receiveMouse = false;
    this.hook = new KeyboardHook({
      allowedCodes: this.allowedCodes,
      suppressLocal: true,
      onInput: (event) => this.sendGuestInput(event),
      onToggle: () => this.toggleCapture()
    });
    this.hook.start();
    this.setupMouseHook({
      suppressLocal: true,
      onMouse: (event) => this.sendGuestMouse(event)
    });
    this.ws = createTransport({ transportMode, relayUrl, directHost, directPort, udpPort, role: "guest", side: "join", name });

    this.ws.on("open", () => {
      sendJson(this.ws, {
        type: MESSAGE_TYPES.GUEST_JOIN,
        roomCode: String(roomCode || "").trim().toUpperCase(),
        guestName: name || "Guest"
      });
      this.emitStatus(`Connected over ${transportLabel(transportMode)}. Waiting for host approval...`);
    });

    this.ws.on("message", (raw) => this.handleGuestMessage(raw));
    this.attachCommonSocketHandlers();
  }

  handleGuestMessage(raw) {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      if (msg.status === "waiting-approval") {
        this.emitStatus(`Waiting for ${msg.hostName || "host"} to approve you.`);
      } else if (msg.status === "approved") {
        this.approved = true;
        this.setCapture(true, "approved");
      } else if (msg.status === "disconnected") {
        this.approved = false;
        this.setCapture(false, msg.reason || "disconnected");
      }
      return;
    }

    if (msg.type === MESSAGE_TYPES.HOST_PAUSE) {
      this.paused = true;
      this.setCapture(false, "host paused");
      return;
    }

    if (msg.type === MESSAGE_TYPES.HOST_RESUME) {
      this.paused = false;
      this.setCapture(true, "host resumed");
      return;
    }

    if (msg.type === MESSAGE_TYPES.HOST_INPUT_ACK) {
      this.handleCommonMessage(msg);
      return;
    }

    this.handleCommonMessage(msg);
  }

  startMirror({ relayUrl, name, side, roomCode, mouseEnabled = false, transportMode = "relay", directHost, directPort, udpPort }) {
    this.stop({ silent: true });
    this.role = "mirror";
    this.side = side;
    this.transportMode = transportMode;
    this.approved = false;
    this.paused = false;
    this.mouseEnabled = Boolean(mouseEnabled);
    this.receiveMouse = Boolean(mouseEnabled);
    this.hook = new KeyboardHook({
      allowedCodes: this.allowedCodes,
      suppressLocal: false,
      onInput: (event) => this.sendMirrorInput(event),
      onToggle: () => this.toggleCapture()
    });
    this.hook.start();
    this.setupMouseHook({
      suppressLocal: false,
      onMouse: (event) => this.sendMirrorMouse(event)
    });
    this.ws = createTransport({ transportMode, relayUrl, directHost, directPort, udpPort, role: "mirror", side, name });

    this.ws.on("open", () => {
      if (side === "create") {
        sendJson(this.ws, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: `${name || "Player"} (two-way)` });
        this.emitStatus(`${transportLabel(transportMode)} ready. Creating two-way room...`);
      } else {
        sendJson(this.ws, {
          type: MESSAGE_TYPES.GUEST_JOIN,
          roomCode: String(roomCode || "").trim().toUpperCase(),
          guestName: `${name || "Player"} (two-way)`
        });
        this.emitStatus(`Connected over ${transportLabel(transportMode)}. Waiting for approval...`);
      }
    });

    this.ws.on("message", (raw) => this.handleMirrorMessage(raw));
    this.attachCommonSocketHandlers();
  }

  handleMirrorMessage(raw) {
    const msg = safeJsonParse(raw);
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.SERVER_ROOM) {
      this.emitStatus("Two-way room ready.", { roomCode: msg.roomCode, shareUrl: msg.shareUrl });
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_JOIN_REQUEST) {
      this.releaseRemote("new two-way join request");
      this.emit("join-request", { guestName: msg.guestName });
      this.emitStatus(`${msg.guestName} wants to join two-way mode.`);
      return;
    }

    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      if (msg.status === "waiting-approval") {
        this.emitStatus(`Waiting for ${msg.hostName || "creator"} to approve you.`);
      } else if (msg.status === "approved") {
        this.approved = true;
        this.setCapture(true, "approved");
      } else if (msg.status === "guest-disconnected" || msg.status === "disconnected") {
        this.approved = false;
        this.setCapture(false, "peer disconnected");
        this.releaseRemote("peer disconnected");
      }
      return;
    }

    const remoteType = this.side === "create" ? MESSAGE_TYPES.GUEST_INPUT : MESSAGE_TYPES.HOST_INPUT;
    if (msg.type === remoteType) {
      const ok = this.injectRemote(msg.event);
      const ackType = this.side === "create" ? MESSAGE_TYPES.HOST_INPUT_ACK : MESSAGE_TYPES.GUEST_INPUT_ACK;
      this.sendInputAck(ackType, msg, ok);
      return;
    }

    const remoteMouseType = this.side === "create" ? MESSAGE_TYPES.GUEST_MOUSE : MESSAGE_TYPES.HOST_MOUSE;
    if (msg.type === remoteMouseType) {
      const ok = this.injectRemoteMouse(msg.event);
      const ackType = this.side === "create" ? MESSAGE_TYPES.HOST_INPUT_ACK : MESSAGE_TYPES.GUEST_INPUT_ACK;
      this.sendInputAck(ackType, msg, ok);
      return;
    }

    this.handleCommonMessage(msg);
  }

  sendGuestInput(event) {
    sendJson(this.ws, {
      type: MESSAGE_TYPES.GUEST_INPUT,
      event: this.withLatencyProbe(event, "key")
    });
  }

  sendGuestMouse(event) {
    sendJson(this.ws, {
      type: MESSAGE_TYPES.GUEST_MOUSE,
      event: this.withLatencyProbe(event, "mouse")
    });
  }

  sendMirrorInput(event) {
    const type = this.side === "create" ? MESSAGE_TYPES.HOST_INPUT : MESSAGE_TYPES.GUEST_INPUT;
    sendJson(this.ws, {
      type,
      event: this.withLatencyProbe({ ...event, origin: this.side, mirrored: true }, "key")
    });
  }

  sendMirrorMouse(event) {
    const type = this.side === "create" ? MESSAGE_TYPES.HOST_MOUSE : MESSAGE_TYPES.GUEST_MOUSE;
    sendJson(this.ws, {
      type,
      event: this.withLatencyProbe({ ...event, origin: this.side, mirrored: true }, "mouse")
    });
  }

  withLatencyProbe(event, inputKind) {
    const latencyId = `${Date.now()}-${++this.nextLatencyId}`;
    const sentAt = Date.now();
    this.pendingInputAcks.set(latencyId, { sentAt, inputKind });
    if (this.pendingInputAcks.size > 128) {
      const oldest = this.pendingInputAcks.keys().next().value;
      this.pendingInputAcks.delete(oldest);
    }
    return {
      ...event,
      latencyId,
      latencySentAt: sentAt,
      inputKind
    };
  }

  sendInputAck(type, msg, ok) {
    const event = msg?.event || {};
    if (!event.latencyId) return;
    sendJson(this.ws, {
      type,
      latencyId: event.latencyId,
      latencySentAt: event.latencySentAt,
      inputKind: event.inputKind || (event.kind ? "mouse" : "key"),
      ok: Boolean(ok),
      receivedAt: Date.now()
    });
  }

  startRelayPing() {
    this.stopRelayPing();
    this.pingTimer = setInterval(() => {
      sendJson(this.ws, { type: MESSAGE_TYPES.GUEST_PING, t: Date.now() });
    }, 1000);
    this.pingTimer.unref();
    sendJson(this.ws, { type: MESSAGE_TYPES.GUEST_PING, t: Date.now() });
  }

  stopRelayPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  setupMouseHook({ suppressLocal, onMouse }) {
    if (!this.mouseEnabled) return;
    this.mouseHook = new MouseHook({ suppressLocal, onMouse });
    this.mouseHook.start();
  }

  setCapture(active, reason) {
    const canCapture = Boolean(active && this.approved && !this.paused && this.ws?.readyState === WebSocket.OPEN);
    this.captureOn = canCapture;
    if (this.hook) this.hook.setArmed(canCapture);
    if (this.mouseHook) this.mouseHook.setArmed(canCapture);
    const label = this.mouseEnabled ? "Keyboard and mouse" : (this.role === "mirror" ? "Two-way" : "Keyboard");
    this.emitStatus(`${label} capture ${canCapture ? "active" : "inactive"}.`, { reason });
  }

  toggleCapture() {
    this.setCapture(!this.captureOn, "manual toggle");
  }

  validateRemote(event) {
    if (!event || typeof event.code !== "string" || typeof event.down !== "boolean") {
      return "Malformed remote input event.";
    }
    if (!this.allowedCodes.has(event.code)) {
      return `Blocked ${event.code}; it is not in the allowlist.`;
    }
    if (isBlockedCombo(event.code, this.remoteActiveCodes)) {
      return `Blocked dangerous combo involving ${event.code}.`;
    }
    if (!input.hasKeyCode(event.code)) {
      return `No ${process.platform} key mapping for ${event.code}.`;
    }
    if (!this.targetWindow || !input.isForegroundWindow(this.targetWindow.rawHwnd)) {
      return "Target window is not foreground.";
    }
    if (this.role === "host" && this.paused) {
      return "Host is paused.";
    }
    return null;
  }

  injectRemote(event) {
    const before = new Set(this.remoteActiveCodes);
    if (event.down) this.remoteActiveCodes.add(event.code);
    else this.remoteActiveCodes.delete(event.code);

    const failure = this.validateRemote(event);
    if (failure) {
      this.remoteActiveCodes.clear();
      for (const code of before) this.remoteActiveCodes.add(code);
      if (event.down) this.emitStatus(failure, { level: "warn" });
      this.releaseRemote("blocked or unsafe remote input");
      return false;
    }

    if (event.down) {
      if (this.remoteHeldCodes.has(event.code)) return true;
      this.remoteHeldCodes.add(event.code);
    } else {
      if (!this.remoteHeldCodes.has(event.code)) return true;
      this.remoteHeldCodes.delete(event.code);
    }

    try {
      if (this.hook?.ignoreNext) this.hook.ignoreNext(event.code, event.down);
      input.sendKey(event.code, event.down);
      this.lastRemoteInputAt = Date.now();
      this.emit("input", { code: event.code, down: event.down });
      return true;
    } catch (err) {
      this.emitStatus(err.message, { level: "error" });
      this.releaseRemote("input injection error");
      return false;
    }
  }

  validateRemoteMouse(event) {
    if (!this.receiveMouse) {
      return "Remote mouse is disabled.";
    }
    if (!event || typeof event.kind !== "string") {
      return "Malformed remote mouse event.";
    }
    if (!this.targetWindow || !input.isForegroundWindow(this.targetWindow.rawHwnd)) {
      return "Target window is not foreground.";
    }
    if (this.role === "host" && this.paused) {
      return "Host is paused.";
    }
    if (event.kind === "button" && !["left", "right", "middle"].includes(event.button)) {
      return `Blocked unsupported mouse button ${event.button}.`;
    }
    if (event.kind === "move" && (Math.abs(event.dx || 0) > 4000 || Math.abs(event.dy || 0) > 4000)) {
      return "Blocked suspicious mouse movement.";
    }
    return null;
  }

  injectRemoteMouse(event) {
    const failure = this.validateRemoteMouse(event);
    if (failure) {
      if (event?.kind !== "move") this.emitStatus(failure, { level: "warn" });
      this.releaseRemoteMouse("blocked or unsafe remote mouse");
      return false;
    }

    try {
      input.sendMouse(event);
      if (event.kind === "button") {
        const key = event.button;
        if (event.down) this.remoteMouseButtons.add(key);
        else this.remoteMouseButtons.delete(key);
      }
      this.lastRemoteInputAt = Date.now();
      this.emit("input", { code: mouseLabel(event), down: event.down ?? true });
      return true;
    } catch (err) {
      this.emitStatus(err.message, { level: "error" });
      this.releaseRemoteMouse("mouse injection error");
      return false;
    }
  }

  releaseRemote(reason) {
    for (const code of [...this.remoteHeldCodes]) {
      if (input.hasKeyCode(code)) {
        try {
          if (this.hook?.ignoreNext) this.hook.ignoreNext(code, false);
          input.sendKey(code, false);
        } catch (err) {
          this.emitStatus(`Failed to release ${code}: ${err.message}`, { level: "error" });
        }
      }
      this.remoteHeldCodes.delete(code);
    }
    this.remoteActiveCodes.clear();
    this.releaseRemoteMouse(reason);
    if (reason) this.emitStatus(`Released remote keys (${reason}).`);
  }

  releaseRemoteMouse(reason) {
    for (const button of [...this.remoteMouseButtons]) {
      try {
        input.sendMouse({ kind: "button", button, down: false });
      } catch (err) {
        this.emitStatus(`Failed to release mouse ${button}: ${err.message}`, { level: "error" });
      }
      this.remoteMouseButtons.delete(button);
    }
    if (reason && this.remoteMouseButtons.size) this.emitStatus(`Released remote mouse (${reason}).`);
  }

  handleCommonMessage(msg) {
    if (msg.type === MESSAGE_TYPES.SERVER_PONG) {
      this.emit("ping", { kind: "relay", ms: Date.now() - msg.t });
      return;
    }
    if (msg.type === MESSAGE_TYPES.HOST_INPUT_ACK || msg.type === MESSAGE_TYPES.GUEST_INPUT_ACK) {
      const pending = this.pendingInputAcks.get(msg.latencyId);
      const sentAt = pending?.sentAt || msg.latencySentAt;
      if (msg.latencyId) this.pendingInputAcks.delete(msg.latencyId);
      if (sentAt) {
        this.emit("ping", {
          kind: "input",
          inputKind: msg.inputKind || pending?.inputKind || "input",
          ok: msg.ok !== false,
          ms: Date.now() - sentAt
        });
      }
      return;
    }
    if (msg.type === MESSAGE_TYPES.SERVER_ERROR) {
      this.emitStatus(`Transport error: ${msg.message}`, { level: "error" });
    }
  }

  attachCommonSocketHandlers() {
    this.ws.on("open", () => this.startRelayPing());
    this.ws.on("close", () => {
      this.approved = false;
      this.setCapture(false, "relay disconnected");
      this.releaseRemote("relay disconnected");
      this.stopRelayPing();
      this.emitStatus(`${transportLabel(this.transportMode)} disconnected.`);
    });
    this.ws.on("error", (err) => {
      this.emitStatus(`${transportLabel(this.transportMode)} connection error: ${err.message}`, { level: "error" });
    });
  }

  watchdogTick() {
    const ackCutoff = Date.now() - 5000;
    for (const [id, pending] of this.pendingInputAcks) {
      if (pending.sentAt < ackCutoff) this.pendingInputAcks.delete(id);
    }
    if (this.remoteHeldCodes.size && Date.now() - this.lastRemoteInputAt > 3000) {
      this.releaseRemote("stuck-key watchdog");
    }
    if (this.remoteHeldCodes.size && this.targetWindow && !input.isForegroundWindow(this.targetWindow.rawHwnd)) {
      this.releaseRemote("target lost focus");
    }
  }

  stop({ silent = false } = {}) {
    this.releaseRemote("stopped");
    if (this.hook) {
      this.hook.stop();
      this.hook = null;
    }
    if (this.mouseHook) {
      this.mouseHook.stop();
      this.mouseHook = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.stopRelayPing();
    this.pendingInputAcks.clear();
    this.role = null;
    this.side = null;
    this.transportMode = "relay";
    this.paused = false;
    this.approved = false;
    this.captureOn = false;
    this.mouseEnabled = false;
    this.receiveMouse = false;
    if (!silent) this.emitStatus("Stopped.");
  }

  destroy() {
    this.stop({ silent: true });
    clearInterval(this.watchdog);
  }
}

module.exports = {
  DesktopEngine
};

function mouseLabel(event) {
  if (!event) return "Mouse";
  if (event.kind === "button") return `Mouse ${event.button}`;
  if (event.kind === "wheel") return `Mouse wheel ${event.axis || "vertical"}`;
  return "Mouse move";
}

function transportLabel(mode) {
  if (mode === "direct-tcp") return "Direct TCP";
  if (mode === "direct-udp") return "Direct UDP";
  return "Relay";
}
