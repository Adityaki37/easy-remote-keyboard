"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("erk", {
  getState: () => ipcRenderer.invoke("engine:get-state"),
  lockTarget: (delayMs) => ipcRenderer.invoke("engine:lock-target", delayMs),
  startHost: (options) => ipcRenderer.invoke("engine:start-host", options),
  startGuest: (options) => ipcRenderer.invoke("engine:start-guest", options),
  startMirror: (options) => ipcRenderer.invoke("engine:start-mirror", options),
  approve: () => ipcRenderer.invoke("engine:approve"),
  reject: () => ipcRenderer.invoke("engine:reject"),
  pause: () => ipcRenderer.invoke("engine:pause"),
  resume: () => ipcRenderer.invoke("engine:resume"),
  disconnect: () => ipcRenderer.invoke("engine:disconnect"),
  toggleCapture: () => ipcRenderer.invoke("engine:toggle-capture"),
  stop: () => ipcRenderer.invoke("engine:stop"),
  onStatus: (handler) => ipcRenderer.on("engine:status", (_event, payload) => handler(payload)),
  onJoinRequest: (handler) => ipcRenderer.on("engine:join-request", (_event, payload) => handler(payload)),
  onPing: (handler) => ipcRenderer.on("engine:ping", (_event, payload) => handler(payload)),
  onInput: (handler) => ipcRenderer.on("engine:input", (_event, payload) => handler(payload))
});
