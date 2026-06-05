"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { ensureNativeKoffi } = require("./ensure-native-koffi");

const root = path.resolve(__dirname, "..");
const platform = process.argv[2] || "all";

ensureNativeKoffi("koffi-win32-x64");
ensureNativeKoffi("koffi-darwin-x64");
ensureNativeKoffi("koffi-darwin-arm64");

const args = ["electron-builder"];
if (platform === "win") {
  args.push("--win", "portable", "--x64");
} else if (platform === "mac") {
  args.push("--mac", "zip", "--x64", "--arm64");
} else {
  args.push("--win", "portable", "--x64", "--mac", "zip", "--x64", "--arm64");
}

const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32"
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
