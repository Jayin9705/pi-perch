"use strict";

/**
 * Run the raw-socket guard checks against a live plugin server.
 *
 * The child has to be spawned asynchronously: `execFileSync` would block this
 * process's event loop, and the server under test lives in this very process, so a
 * synchronous child would find a port that never answers.
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHarness, loadPlugin } = require("./harness");

const PLUGIN_ROOT = path.join(__dirname, "..", "plugin");

function runChild(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
    child.on("error", (error) => resolve({ code: 1, out: String(error?.message ?? error) }));
  });
}

(async () => {
  const harness = createHarness({ settings: { enabled: true, preferredPort: 41994, refreshSeconds: 600 } });
  const { plugin, restore } = loadPlugin(harness, PLUGIN_ROOT);
  try {
    await plugin.onLoad();
    const status = await plugin.onPanelInvoke("perch.status", {});
    if (!status.baseUrl) throw new Error("the server is not listening");
    console.log("guards against " + status.baseUrl);
    const result = await runChild(path.join(__dirname, "guards.js"), [status.baseUrl]);
    process.stdout.write(result.out);
    if (result.code !== 0) process.exitCode = result.code;
  } catch (error) {
    console.error("FATAL: " + (error?.stack ?? error));
    process.exitCode = 1;
  } finally {
    await plugin.onUnload().catch(() => {});
    restore();
    harness.cleanup();
    setTimeout(() => process.exit(process.exitCode ?? 0), 250);
  }
})();
