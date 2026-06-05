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

function parseAllowlist(value) {
  if (!value) return new Set(DEFAULT_ALLOWED_CODES);
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

class DesktopEngine extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.hook = null;
    this.role = null;
    this.side = null;
    this.targetWindow = null;
    this.paused = false;
    this.approved = false;
    this.captureOn = false;
    this.remoteHeldCodes = new Set();
    this.remoteActiveCodes = new Set();
    this.allowedCodes = parseAllowlist(process.env.ALLOW_KEYS);
    this.lastRemoteInputAt = 0;
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

  startHost({ relayUrl, name }) {
    this.stop({ silent: true });
    this.role = "host";
    this.side = "create";
    this.paused = false;
    this.approved = false;
    this.ws = new WebSocket(relayUrl);

    this.ws.on("open", () => {
      sendJson(this.ws, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: name || "Host" });
      this.emitStatus("Connected to relay. Creating host room...");
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
      this.injectRemote(msg.event);
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

  startGuest({ relayUrl, roomCode, name }) {
    this.stop({ silent: true });
    this.role = "guest";
    this.side = "join";
    this.approved = false;
    this.paused = false;
    this.hook = new KeyboardHook({
      allowedCodes: this.allowedCodes,
      suppressLocal: true,
      onInput: (event) => sendJson(this.ws, { type: MESSAGE_TYPES.GUEST_INPUT, event }),
      onToggle: () => this.toggleCapture()
    });
    this.hook.start();
    this.ws = new WebSocket(relayUrl);

    this.ws.on("open", () => {
      sendJson(this.ws, {
        type: MESSAGE_TYPES.GUEST_JOIN,
        roomCode: String(roomCode || "").trim().toUpperCase(),
        guestName: name || "Guest"
      });
      this.emitStatus("Connected to relay. Waiting for host approval...");
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

    this.handleCommonMessage(msg);
  }

  startMirror({ relayUrl, name, side, roomCode }) {
    this.stop({ silent: true });
    this.role = "mirror";
    this.side = side;
    this.approved = false;
    this.paused = false;
    this.hook = new KeyboardHook({
      allowedCodes: this.allowedCodes,
      suppressLocal: false,
      onInput: (event) => this.sendMirrorInput(event),
      onToggle: () => this.toggleCapture()
    });
    this.hook.start();
    this.ws = new WebSocket(relayUrl);

    this.ws.on("open", () => {
      if (side === "create") {
        sendJson(this.ws, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: `${name || "Player"} (two-way)` });
        this.emitStatus("Connected to relay. Creating two-way room...");
      } else {
        sendJson(this.ws, {
          type: MESSAGE_TYPES.GUEST_JOIN,
          roomCode: String(roomCode || "").trim().toUpperCase(),
          guestName: `${name || "Player"} (two-way)`
        });
        this.emitStatus("Connected to relay. Waiting for approval...");
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
      this.injectRemote(msg.event);
      return;
    }

    this.handleCommonMessage(msg);
  }

  sendMirrorInput(event) {
    const type = this.side === "create" ? MESSAGE_TYPES.HOST_INPUT : MESSAGE_TYPES.GUEST_INPUT;
    sendJson(this.ws, {
      type,
      event: { ...event, origin: this.side, mirrored: true }
    });
  }

  setCapture(active, reason) {
    const canCapture = Boolean(active && this.approved && !this.paused && this.ws?.readyState === WebSocket.OPEN);
    this.captureOn = canCapture;
    if (this.hook) this.hook.setArmed(canCapture);
    this.emitStatus(`${this.role === "mirror" ? "Two-way" : "Keyboard"} capture ${canCapture ? "active" : "inactive"}.`, { reason });
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
      return;
    }

    if (event.down) {
      if (this.remoteHeldCodes.has(event.code)) return;
      this.remoteHeldCodes.add(event.code);
    } else {
      if (!this.remoteHeldCodes.has(event.code)) return;
      this.remoteHeldCodes.delete(event.code);
    }

    try {
      if (this.hook?.ignoreNext) this.hook.ignoreNext(event.code, event.down);
      input.sendKey(event.code, event.down);
      this.lastRemoteInputAt = Date.now();
      this.emit("input", { code: event.code, down: event.down });
    } catch (err) {
      this.emitStatus(err.message, { level: "error" });
      this.releaseRemote("input injection error");
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
    if (reason) this.emitStatus(`Released remote keys (${reason}).`);
  }

  handleCommonMessage(msg) {
    if (msg.type === MESSAGE_TYPES.SERVER_PONG) {
      this.emit("ping", { ms: Date.now() - msg.t });
      return;
    }
    if (msg.type === MESSAGE_TYPES.SERVER_ERROR) {
      this.emitStatus(`Relay error: ${msg.message}`, { level: "error" });
    }
  }

  attachCommonSocketHandlers() {
    this.ws.on("close", () => {
      this.approved = false;
      this.setCapture(false, "relay disconnected");
      this.releaseRemote("relay disconnected");
      this.emitStatus("Relay disconnected.");
    });
    this.ws.on("error", (err) => {
      this.emitStatus(`Relay connection error: ${err.message}`, { level: "error" });
    });
  }

  watchdogTick() {
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
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.role = null;
    this.side = null;
    this.paused = false;
    this.approved = false;
    this.captureOn = false;
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
