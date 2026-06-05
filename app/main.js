#!/usr/bin/env node
"use strict";

const readline = require("node:readline");

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  console.clear();
  console.log("Easy Remote Keyboard");
  console.log("====================");
  console.log("Choose what this computer should do:");
  console.log("");
  console.log("1. Host - let a friend control a focused app/game on this computer");
  console.log("2. Guest - send this computer's keyboard to a friend's host");
  console.log("3. Two-way - both computers send keyboard input to each other");
  console.log("");

  const mode = process.env.ERK_MODE?.trim().toLowerCase() || await ask("Type 1/host or 2/guest, then press Enter: ");
  console.log("");

  if (mode === "1" || mode === "h" || mode === "host") {
    await require("../host/main").main();
    return;
  }

  if (mode === "2" || mode === "g" || mode === "guest") {
    await require("../guest/main").main();
    return;
  }

  if (mode === "3" || mode === "t" || mode === "two-way" || mode === "twoway" || mode === "mirror") {
    await require("../mirror/main").main();
    return;
  }

  console.error("Unknown mode. Restart and choose host, guest, or two-way.");
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  main
};
