"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const scopeDir = path.join(root, "node_modules", "@koromix");
const cacheDir = path.join(root, ".cache", "native-packages");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd")
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function ensureNativeKoffi(packageName) {
  const target = path.join(scopeDir, packageName);
  const nativeFiles = fs.existsSync(target)
    ? fs.readdirSync(target, { recursive: true }).filter((file) => String(file).endsWith(".node"))
    : [];
  if (nativeFiles.length > 0) return;

  fs.mkdirSync(scopeDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const spec = `@koromix/${packageName}@3.0.2`;
  const packed = run(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", spec, "--silent"], { cwd: cacheDir });
  const tarball = path.join(cacheDir, packed.split(/\r?\n/).pop());
  const unpackDir = path.join(cacheDir, `${packageName}-unpack`);
  fs.rmSync(unpackDir, { recursive: true, force: true });
  fs.mkdirSync(unpackDir, { recursive: true });

  run(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", tarball, "-C", unpackDir]);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(unpackDir, "package"), target);
}

module.exports = {
  ensureNativeKoffi
};
