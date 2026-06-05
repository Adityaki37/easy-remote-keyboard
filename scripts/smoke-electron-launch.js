"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const electronBin = require("electron");

const child = spawn(electronBin, ["desktop/main.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1"
  }
});

let output = "";
child.stdout.on("data", (data) => {
  output += data.toString();
});
child.stderr.on("data", (data) => {
  output += data.toString();
});

const timeout = setTimeout(() => {
  child.kill();
  console.log("Electron launch smoke passed.");
}, 4500);

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code && code !== 0) {
    console.error(output);
    process.exit(code);
  }
});
