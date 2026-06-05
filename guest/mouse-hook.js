"use strict";

if (process.platform === "win32") {
  module.exports = require("./mouse-hook-win32");
} else if (process.platform === "darwin") {
  module.exports = require("./mouse-hook-macos");
} else {
  throw new Error(`Unsupported mouse hook platform: ${process.platform}. Windows and macOS are supported.`);
}
