"use strict";

if (process.platform === "win32") {
  module.exports = require("./keyboard-hook-win32");
} else if (process.platform === "darwin") {
  module.exports = require("./keyboard-hook-macos");
} else {
  throw new Error(`Unsupported guest platform: ${process.platform}. Windows and macOS are supported.`);
}
