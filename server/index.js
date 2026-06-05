"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { customAlphabet } = require("nanoid");
const { MESSAGE_TYPES, safeJsonParse, sendJson } = require("../shared/protocol");

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const newRoomCode = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", 6);

const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: "5m"
}));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map();

function makeRoom(hostWs, hostName) {
  let code;
  do {
    code = newRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    hostWs,
    hostName: hostName || "Host",
    guestWs: null,
    guestName: null,
    approved: false,
    secret: crypto.randomBytes(12).toString("hex"),
    createdAt: Date.now()
  };
  rooms.set(code, room);
  hostWs.role = "host";
  hostWs.roomCode = code;
  return room;
}

function closeGuest(room, reason) {
  if (!room?.guestWs) return;
  sendJson(room.guestWs, {
    type: MESSAGE_TYPES.SERVER_GUEST_STATUS,
    status: "disconnected",
    reason
  });
  try {
    room.guestWs.close(1000, reason || "closed");
  } catch {}
  room.guestWs = null;
  room.guestName = null;
  room.approved = false;
}

function cleanup(ws) {
  const code = ws.roomCode;
  if (!code || !rooms.has(code)) return;
  const room = rooms.get(code);

  if (ws.role === "host") {
    closeGuest(room, "Host disconnected.");
    rooms.delete(code);
    return;
  }

  if (ws.role === "guest" && room.guestWs === ws) {
    room.guestWs = null;
    room.guestName = null;
    room.approved = false;
    sendJson(room.hostWs, {
      type: MESSAGE_TYPES.SERVER_GUEST_STATUS,
      status: "guest-disconnected"
    });
  }
}

function handleHost(ws, msg) {
  if (msg.type === MESSAGE_TYPES.HOST_REGISTER) {
    const room = makeRoom(ws, msg.hostName);
    sendJson(ws, {
      type: MESSAGE_TYPES.SERVER_ROOM,
      roomCode: room.code,
      shareUrl: `${PUBLIC_BASE_URL}/?room=${room.code}`,
      createdAt: room.createdAt
    });
    return;
  }

  const room = rooms.get(ws.roomCode);
  if (!room || room.hostWs !== ws) {
    sendJson(ws, { type: MESSAGE_TYPES.SERVER_ERROR, message: "Host is not registered." });
    return;
  }

  if (msg.type === MESSAGE_TYPES.HOST_APPROVE) {
    room.approved = true;
    sendJson(room.guestWs, {
      type: MESSAGE_TYPES.SERVER_GUEST_STATUS,
      status: "approved"
    });
    sendJson(ws, {
      type: MESSAGE_TYPES.SERVER_GUEST_STATUS,
      status: "approved",
      guestName: room.guestName
    });
    return;
  }

  if (msg.type === MESSAGE_TYPES.HOST_REJECT) {
    closeGuest(room, "Host rejected connection.");
    return;
  }

  if (msg.type === MESSAGE_TYPES.HOST_DISCONNECT_GUEST) {
    closeGuest(room, "Host disconnected guest.");
    return;
  }

  if (msg.type === MESSAGE_TYPES.HOST_PAUSE || msg.type === MESSAGE_TYPES.HOST_RESUME) {
    sendJson(room.guestWs, { type: msg.type });
    return;
  }

  if (msg.type === MESSAGE_TYPES.HOST_INPUT) {
    if (!room.approved) return;
    sendJson(room.guestWs, msg);
  }
}

function handleGuest(ws, msg) {
  if (msg.type === MESSAGE_TYPES.GUEST_JOIN) {
    const code = String(msg.roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      sendJson(ws, { type: MESSAGE_TYPES.SERVER_ERROR, message: "Room not found." });
      return;
    }
    if (room.guestWs) {
      sendJson(ws, { type: MESSAGE_TYPES.SERVER_ERROR, message: "Room already has a guest." });
      return;
    }

    ws.role = "guest";
    ws.roomCode = code;
    room.guestWs = ws;
    room.guestName = String(msg.guestName || "Friend").slice(0, 32);
    room.approved = false;
    sendJson(ws, {
      type: MESSAGE_TYPES.SERVER_GUEST_STATUS,
      status: "waiting-approval",
      hostName: room.hostName
    });
    sendJson(room.hostWs, {
      type: MESSAGE_TYPES.SERVER_JOIN_REQUEST,
      guestName: room.guestName
    });
    return;
  }

  const room = rooms.get(ws.roomCode);
  if (!room || room.guestWs !== ws) return;

  if (msg.type === MESSAGE_TYPES.GUEST_INPUT) {
    if (!room.approved) return;
    sendJson(room.hostWs, msg);
    return;
  }

  if (msg.type === MESSAGE_TYPES.GUEST_PING) {
    sendJson(ws, {
      type: MESSAGE_TYPES.SERVER_PONG,
      t: msg.t,
      serverTime: Date.now()
    });
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const msg = safeJsonParse(raw);
    if (!msg || typeof msg.type !== "string") {
      sendJson(ws, { type: MESSAGE_TYPES.SERVER_ERROR, message: "Invalid message." });
      return;
    }
    if (msg.type.startsWith("host/")) handleHost(ws, msg);
    else if (msg.type.startsWith("guest/")) handleGuest(ws, msg);
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));
});

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.createdAt < cutoff) {
      closeGuest(room, "Room expired.");
      try {
        room.hostWs.close(1000, "Room expired.");
      } catch {}
      rooms.delete(code);
    }
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`Easy Remote Keyboard relay running on ${PUBLIC_BASE_URL}`);
  console.log(`Friend page: ${PUBLIC_BASE_URL}/`);
});
