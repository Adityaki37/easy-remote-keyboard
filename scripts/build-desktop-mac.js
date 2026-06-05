"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const tar = require("tar");
const { ensureNativeKoffi } = require("./ensure-native-koffi");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "release-mac");
const packagerBin = path.join(root, "node_modules", "@electron", "packager", "bin", "electron-packager.mjs");

ensureNativeKoffi("koffi-darwin-x64");
ensureNativeKoffi("koffi-darwin-arm64");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const arch of ["arm64", "x64"]) {
  const result = spawnSync(
    process.execPath,
    [
      packagerBin,
      ".",
      "Easy Remote Keyboard",
      "--platform=darwin",
      `--arch=${arch}`,
      `--out=${out}`,
      "--overwrite",
      "--asar",
      "--prune=true",
      "--ignore=^/release($|/)",
      "--ignore=^/release-mac($|/)",
      "--ignore=^/dist($|/)",
      "--ignore=^/.cache($|/)",
      "--ignore=^/.git($|/)"
    ],
    {
      cwd: root,
      stdio: "inherit"
    }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);

  const folder = path.join(out, `Easy Remote Keyboard-darwin-${arch}`);
  const appPath = path.join(folder, "Easy Remote Keyboard.app");
  const packageName = `EasyRemoteKeyboard-macos-${arch}-app.tar.gz`;
  const packagePath = path.join(out, packageName);
  const readmePath = path.join(folder, "README.txt");
  fs.writeFileSync(
    readmePath,
    [
      `Easy Remote Keyboard macOS app (${arch})`,
      "",
      "Drag Easy Remote Keyboard.app to Applications, then double-click it.",
      "",
      "This build is unsigned/not notarized. If macOS blocks it, open System Settings > Privacy & Security and choose Open Anyway.",
      "Host mode needs Accessibility permission. Guest and Two-way capture need Input Monitoring permission.",
      ""
    ].join("\n")
  );
  tar.c(
    {
      gzip: true,
      cwd: folder,
      file: packagePath,
      portable: true
    },
    [path.basename(appPath), "README.txt"]
  ).sync();
  console.log(`Built ${packagePath}`);
}
