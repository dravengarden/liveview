#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");

const BIN_NAME = process.platform === "win32" ? "lv.exe" : "lv";
const binPath = path.join(__dirname, "bin", BIN_NAME);

const child = spawn(binPath, process.argv.slice(2), {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code);
});
