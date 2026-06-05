"use strict";

const { EventEmitter } = require("node:events");
const net = require("node:net");
const os = require("node:os");
const dgram = require("node:dgram");
const WebSocket = require("ws");
const { MESSAGE_TYPES, safeJsonParse } = require("../shared/protocol");

const DEFAULT_DIRECT_PORT = 8788;
const DEFAULT_UDP_PORT = 8789;
const OPEN = WebSocket.OPEN;
const CLOSED = WebSocket.CLOSED;
const INPUT_TYPES = new Set([
  MESSAGE_TYPES.HOST_INPUT,
  MESSAGE_TYPES.HOST_MOUSE,
  MESSAGE_TYPES.HOST_INPUT_ACK,
  MESSAGE_TYPES.GUEST_INPUT,
  MESSAGE_TYPES.GUEST_MOUSE,
  MESSAGE_TYPES.GUEST_INPUT_ACK,
  MESSAGE_TYPES.GUEST_PING,
  MESSAGE_TYPES.SERVER_PONG
]);

function createTransport(options) {
  const mode = options.transportMode || "relay";
  if (mode === "direct-tcp") return new DirectTcpTransport(options);
  if (mode === "direct-udp") return new DirectUdpTransport(options);
  return new RelayTransport(options);
}

class RelayTransport extends WebSocket {
  constructor({ relayUrl }) {
    super(relayUrl);
  }
}

class FramedSocket {
  constructor(socket, onMessage) {
    this.socket = socket;
    this.buffer = "";
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) onMessage(line);
      }
    });
  }

  send(payload) {
    if (!this.socket.destroyed) this.socket.write(`${payload}\n`);
  }

  close() {
    this.socket.destroy();
  }
}

class BaseDirectTransport extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.role = options.role;
    this.readyState = CLOSED;
    this.OPEN = OPEN;
  }

  emitJson(message) {
    this.emit("message", JSON.stringify(message));
  }

  send(payload) {
    const msg = safeJsonParse(payload);
    if (!msg) return;
    this.handleLocalSend(msg, payload);
  }

  handleLocalSend() {}

  close() {
    this.readyState = CLOSED;
    this.emit("close");
  }
}

class DirectTcpTransport extends BaseDirectTransport {
  constructor(options) {
    super(options);
    this.port = Number(options.directPort || DEFAULT_DIRECT_PORT);
    this.host = options.directHost || "127.0.0.1";
    this.server = null;
    this.frame = null;
    this.approved = false;

    if (options.role === "host" || options.side === "create") this.startServer();
    else this.connectClient();
  }

  startServer() {
    this.server = net.createServer((socket) => {
      if (this.frame) {
        socket.destroy();
        return;
      }
      this.frame = new FramedSocket(socket, (line) => this.handlePeerMessage(line));
      socket.on("close", () => this.handlePeerClosed());
      socket.on("error", (err) => this.emit("error", err));
    });
    this.server.on("error", (err) => this.emit("error", err));
    this.server.listen(this.port, "0.0.0.0", () => {
      this.readyState = OPEN;
      this.emit("open");
    });
  }

  connectClient() {
    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.frame = new FramedSocket(socket, (line) => this.handlePeerMessage(line));
      this.readyState = OPEN;
      this.emit("open");
    });
    socket.on("close", () => this.handlePeerClosed());
    socket.on("error", (err) => this.emit("error", err));
  }

  handleLocalSend(msg, payload) {
    if (msg.type === MESSAGE_TYPES.HOST_REGISTER) {
      this.emitJson({
        type: MESSAGE_TYPES.SERVER_ROOM,
        roomCode: "DIRECT",
        shareUrl: directSummary(this.port),
        createdAt: Date.now()
      });
      return;
    }
    if (msg.type === MESSAGE_TYPES.HOST_APPROVE) {
      this.approved = true;
      this.sendToPeer({ type: MESSAGE_TYPES.SERVER_GUEST_STATUS, status: "approved" });
      this.emitJson({ type: MESSAGE_TYPES.SERVER_GUEST_STATUS, status: "approved", guestName: this.guestName || "Guest" });
      return;
    }
    if (msg.type === MESSAGE_TYPES.HOST_REJECT) {
      this.sendToPeer({ type: MESSAGE_TYPES.SERVER_GUEST_STATUS, status: "disconnected", reason: "Host rejected connection." });
      this.closePeer();
      return;
    }
    if (msg.type === MESSAGE_TYPES.HOST_DISCONNECT_GUEST) {
      this.sendToPeer({ type: MESSAGE_TYPES.SERVER_GUEST_STATUS, status: "disconnected", reason: "Host disconnected guest." });
      this.closePeer();
      return;
    }
    if (msg.type === MESSAGE_TYPES.GUEST_PING && !this.frame) {
      this.emitJson({ type: MESSAGE_TYPES.SERVER_PONG, t: msg.t, serverTime: Date.now() });
      return;
    }
    this.frame?.send(payload);
  }

  handlePeerMessage(line) {
    const msg = safeJsonParse(line);
    if (!msg) return;
    if (msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS) {
      if (msg.status === "approved") this.approved = true;
      if (msg.status === "disconnected" || msg.status === "guest-disconnected") this.approved = false;
      this.emit("message", line);
      return;
    }
    if (msg.type === MESSAGE_TYPES.GUEST_JOIN) {
      this.guestName = String(msg.guestName || "Guest").slice(0, 32);
      this.approved = false;
      this.emitJson({ type: MESSAGE_TYPES.SERVER_JOIN_REQUEST, guestName: this.guestName });
      this.sendToPeer({ type: MESSAGE_TYPES.SERVER_GUEST_STATUS, status: "waiting-approval", hostName: this.options.name || "Host" });
      return;
    }
    if (msg.type === MESSAGE_TYPES.GUEST_PING) {
      this.sendToPeer({ type: MESSAGE_TYPES.SERVER_PONG, t: msg.t, serverTime: Date.now() });
      return;
    }
    if (isPeerInput(msg) && !this.approved) return;
    if (msg.type === MESSAGE_TYPES.HOST_APPROVE || msg.type === MESSAGE_TYPES.HOST_REJECT) return;
    this.emit("message", line);
  }

  sendToPeer(msg) {
    this.frame?.send(JSON.stringify(msg));
  }

  closePeer() {
    if (this.frame) this.frame.close();
    this.frame = null;
    this.approved = false;
  }

  handlePeerClosed() {
    this.frame = null;
    if (this.role === "host" || this.options.side === "create") {
      this.approved = false;
      this.emitJson({ type: MESSAGE_TYPES.SERVER_GUEST_STATUS, status: "guest-disconnected" });
    } else {
      this.readyState = CLOSED;
      this.emit("close");
    }
  }

  close() {
    this.closePeer();
    if (this.server) this.server.close();
    this.server = null;
    super.close();
  }
}

class DirectUdpTransport extends DirectTcpTransport {
  constructor(options) {
    super(options);
    this.udpPort = Number(options.udpPort || DEFAULT_UDP_PORT);
    this.peerUdp = null;
    this.udp = dgram.createSocket("udp4");
    this.udp.on("message", (buffer, rinfo) => this.handleUdp(buffer, rinfo));
    this.udp.on("error", (err) => this.emit("error", err));
    this.udp.bind(options.role === "host" || options.side === "create" ? this.udpPort : 0);
  }

  handleLocalSend(msg, payload) {
    if (msg.type === MESSAGE_TYPES.HOST_REGISTER) {
      this.emitJson({
        type: MESSAGE_TYPES.SERVER_ROOM,
        roomCode: "UDP",
        shareUrl: `${directSummary(this.port)} UDP ${this.udpPort}`,
        createdAt: Date.now()
      });
      return;
    }
    if (INPUT_TYPES.has(msg.type) && this.peerUdp) {
      this.sendUdp(payload);
      return;
    }
    super.handleLocalSend(msg, payload);
  }

  handlePeerMessage(line) {
    const msg = safeJsonParse(line);
    if (msg?.type === "transport/udp-hello") {
      this.peerUdp = { address: msg.address || this.frame?.socket.remoteAddress || this.host, port: Number(msg.port) };
      return;
    }
    if (msg?.type === "transport/udp-ready") {
      this.peerUdp = { address: msg.address || this.host, port: Number(msg.port) };
      this.sendUdp(JSON.stringify({ type: "transport/udp-hello" }));
      return;
    }
    super.handlePeerMessage(line);
  }

  handleUdp(buffer, rinfo) {
    const line = buffer.toString("utf8");
    const msg = safeJsonParse(line);
    if (!msg) return;
    if (msg.type === "transport/udp-hello") {
      this.peerUdp = { address: rinfo.address, port: rinfo.port };
      return;
    }
    if (msg.type === MESSAGE_TYPES.GUEST_PING) {
      this.sendUdp(JSON.stringify({ type: MESSAGE_TYPES.SERVER_PONG, t: msg.t, serverTime: Date.now() }));
      return;
    }
    if (isPeerInput(msg) && !this.approved) return;
    this.peerUdp = this.peerUdp || { address: rinfo.address, port: rinfo.port };
    this.emit("message", line);
  }

  connectClient() {
    super.connectClient();
    const announce = () => {
      if (!this.frame || !this.udp.address) return;
      const address = this.udp.address();
      this.frame.send(JSON.stringify({ type: "transport/udp-hello", port: address.port }));
    };
    this.once("open", () => setTimeout(announce, 50));
  }

  handlePeerMessageAfterJoin() {}

  sendToPeer(msg) {
    super.sendToPeer(msg);
    if ((msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS && msg.status === "approved") && this.frame && this.udp.address) {
      const address = this.udp.address();
      super.sendToPeer({ type: "transport/udp-ready", port: address.port });
    }
  }

  sendUdp(payload) {
    if (!this.peerUdp) return;
    const buffer = Buffer.from(payload);
    this.udp.send(buffer, this.peerUdp.port, this.peerUdp.address);
  }

  close() {
    try {
      this.udp.close();
    } catch {}
    super.close();
  }
}

function directSummary(port) {
  const ips = localIps();
  return ips.length ? ips.map((ip) => `${ip}:${port}`).join(", ") : `localhost:${port}`;
}

function localIps() {
  const out = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) out.push(address.address);
    }
  }
  return out;
}

function isPeerInput(msg) {
  return msg.type === MESSAGE_TYPES.GUEST_INPUT ||
    msg.type === MESSAGE_TYPES.GUEST_MOUSE ||
    msg.type === MESSAGE_TYPES.GUEST_INPUT_ACK ||
    msg.type === MESSAGE_TYPES.HOST_INPUT ||
    msg.type === MESSAGE_TYPES.HOST_MOUSE ||
    msg.type === MESSAGE_TYPES.HOST_INPUT_ACK;
}

module.exports = {
  createTransport,
  DEFAULT_DIRECT_PORT,
  DEFAULT_UDP_PORT
};
