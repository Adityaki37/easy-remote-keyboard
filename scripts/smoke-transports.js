"use strict";

const assert = require("node:assert/strict");
const { createTransport } = require("../desktop/transports");
const { MESSAGE_TYPES, sendJson } = require("../shared/protocol");

class MessageBox {
  constructor(pipe) {
    this.items = [];
    this.waiters = [];
    pipe.on("message", (raw) => this.push(JSON.parse(raw.toString())));
  }

  push(msg) {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(msg));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter.resolve(msg);
      return;
    }
    this.items.push(msg);
  }

  next(predicate) {
    const index = this.items.findIndex(predicate);
    if (index >= 0) {
      const [msg] = this.items.splice(index, 1);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for transport message."));
      }, 2500);
      this.waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }
}

function open(pipe) {
  return new Promise((resolve, reject) => {
    if (pipe.readyState === pipe.OPEN) return resolve();
    pipe.once("open", resolve);
    pipe.once("error", reject);
  });
}

async function exercise(mode, basePort) {
  const host = createTransport({
    transportMode: mode,
    role: "host",
    side: "create",
    name: "Host",
    directPort: basePort,
    udpPort: basePort + 1
  });
  const hostMessages = new MessageBox(host);
  await open(host);
  sendJson(host, { type: MESSAGE_TYPES.HOST_REGISTER, hostName: "Host" });
  const room = await hostMessages.next((msg) => msg.type === MESSAGE_TYPES.SERVER_ROOM);
  assert.ok(room.roomCode);

  const guest = createTransport({
    transportMode: mode,
    role: "guest",
    side: "join",
    name: "Guest",
    directHost: "127.0.0.1",
    directPort: basePort,
    udpPort: basePort + 1
  });
  const guestMessages = new MessageBox(guest);
  await open(guest);
  sendJson(guest, { type: MESSAGE_TYPES.GUEST_JOIN, roomCode: room.roomCode, guestName: "Guest" });
  const join = await hostMessages.next((msg) => msg.type === MESSAGE_TYPES.SERVER_JOIN_REQUEST);
  assert.equal(join.guestName, "Guest");

  sendJson(host, { type: MESSAGE_TYPES.HOST_APPROVE });
  const approved = await guestMessages.next((msg) => msg.type === MESSAGE_TYPES.SERVER_GUEST_STATUS && msg.status === "approved");
  assert.equal(approved.status, "approved");

  await new Promise((resolve) => setTimeout(resolve, 75));
  sendJson(guest, { type: MESSAGE_TYPES.GUEST_PING, t: Date.now() });
  const pong = await guestMessages.next((msg) => msg.type === MESSAGE_TYPES.SERVER_PONG);
  assert.equal(pong.type, MESSAGE_TYPES.SERVER_PONG);

  const latencyId = `${mode}-latency`;
  sendJson(guest, {
    type: MESSAGE_TYPES.GUEST_INPUT,
    event: { code: "KeyW", down: true, latencyId, latencySentAt: Date.now(), inputKind: "key" }
  });
  const input = await hostMessages.next((msg) => msg.type === MESSAGE_TYPES.GUEST_INPUT);
  assert.equal(input.event.latencyId, latencyId);

  sendJson(host, {
    type: MESSAGE_TYPES.HOST_INPUT_ACK,
    latencyId,
    latencySentAt: input.event.latencySentAt,
    inputKind: "key",
    ok: true
  });
  const ack = await guestMessages.next((msg) => msg.type === MESSAGE_TYPES.HOST_INPUT_ACK);
  assert.equal(ack.latencyId, latencyId);

  host.close();
  guest.close();
}

(async () => {
  await exercise("direct-tcp", 18788);
  await exercise("direct-udp", 18790);
  console.log("Direct transport smoke passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
