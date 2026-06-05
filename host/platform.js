"use strict";

if (process.platform === "win32") {
  module.exports = require("./win32");
} else if (process.platform === "darwin") {
  module.exports = require("./macos");
} else {
  throw new Error(`Unsupported host platform: ${process.platform}. Windows and macOS are supported.`);
}
