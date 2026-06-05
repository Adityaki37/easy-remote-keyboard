"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ensureNativeKoffi } = require("./ensure-native-koffi");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pkgBin = path.join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
fs.mkdirSync(dist, { recursive: true });
ensureNativeKoffi("koffi-darwin-x64");
ensureNativeKoffi("koffi-darwin-arm64");

const builds = [
  ["app/main.js", "node24-macos-x64", "easy-remote-keyboard-macos-x64"],
  ["app/main.js", "node24-macos-arm64", "easy-remote-keyboard-macos-arm64"],
  ["host/main.js", "node24-macos-x64", "easy-remote-keyboard-host-macos-x64"],
  ["host/main.js", "node24-macos-arm64", "easy-remote-keyboard-host-macos-arm64"],
  ["guest/main.js", "node24-macos-x64", "easy-remote-keyboard-guest-macos-x64"],
  ["guest/main.js", "node24-macos-arm64", "easy-remote-keyboard-guest-macos-arm64"]
];

for (const [entry, target, output] of builds) {
  const result = spawnSync(
    process.execPath,
    [pkgBin, entry, "--targets", target, "--no-bytecode", "--public", "--public-packages", "*", "--output", path.join(dist, output)],
    { cwd: root, stdio: "inherit" }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("Built macOS host and guest binaries in dist/.");
