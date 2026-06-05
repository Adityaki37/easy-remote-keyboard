"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { DesktopEngine } = require("./engine");

let mainWindow = null;
const engine = new DesktopEngine();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 760,
    minHeight: 640,
    x: 40,
    y: 40,
    title: "Easy Remote Keyboard",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

engine.on("status", (payload) => send("engine:status", payload));
engine.on("join-request", (payload) => send("engine:join-request", payload));
engine.on("ping", (payload) => send("engine:ping", payload));
engine.on("input", (payload) => send("engine:input", payload));

ipcMain.handle("engine:get-state", () => engine.snapshot());
ipcMain.handle("engine:lock-target", (_event, delayMs) => engine.lockTarget(delayMs));
ipcMain.handle("engine:start-host", (_event, options) => engine.startHost(options));
ipcMain.handle("engine:start-guest", (_event, options) => engine.startGuest(options));
ipcMain.handle("engine:start-mirror", (_event, options) => engine.startMirror(options));
ipcMain.handle("engine:approve", () => engine.approveGuest());
ipcMain.handle("engine:reject", () => engine.rejectGuest());
ipcMain.handle("engine:pause", () => engine.pauseHost());
ipcMain.handle("engine:resume", () => engine.resumeHost());
ipcMain.handle("engine:disconnect", () => engine.disconnectGuest());
ipcMain.handle("engine:toggle-capture", () => engine.toggleCapture());
ipcMain.handle("engine:stop", () => engine.stop());

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  engine.destroy();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
