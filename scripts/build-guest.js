"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ensureNativeKoffi } = require("./ensure-native-koffi");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pkgBin = path.join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
fs.mkdirSync(dist, { recursive: true });
ensureNativeKoffi("koffi-win32-x64");

const result = spawnSync(
  process.execPath,
  [pkgBin, "guest/main.js", "--targets", "node24-win-x64", "--output", path.join(dist, "easy-remote-keyboard-guest.exe")],
  { cwd: root, stdio: "inherit" }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built ${path.join(dist, "easy-remote-keyboard-guest.exe")}`);
