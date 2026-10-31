"use strict";

/**
 * A stand-in host for testing the plugin outside PI-Desktop.
 *
 * The plugin expects a global `pi` object with `plugin.getDataPath`, `commands`,
 * `ui`, `services`, `events` and `net`. This harness supplies those with the same
 * shapes the real host uses, so `main.js` runs unmodified. Everything the plugin
 * would send to the host lands in `host.calls` for assertions.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createHarness(options = {}) {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-perch-test-"));
  const calls = [];
  const commands = new Map();
  const services = new Map();
  const listeners = new Map();
  const toasts = [];

  const settings = { ...(options.settings ?? {}) };

  const host = {
    calls,
    commands,
    services,
    toasts,
    dataDir,
    settings,
    plugin: {
      getId: () => "local.pi-perch",
      getManifest: () => options.manifest ?? {},
      getSettings: async () => ({ ...settings }),
      setSettings: async (partial) => {
        calls.push({ api: "plugin.setSettings", args: [partial] });
        Object.assign(settings, partial);
        return { ok: true };
      },
      getDataPath: async () => {
        calls.push({ api: "plugin.getDataPath", args: [] });
        return dataDir;
      },
    },
    commands: {
      register: async (command) => {
        calls.push({ api: "commands.register", args: [command] });
        commands.set(command.id, command);
        return { ok: true };
      },
      unregister: async (id) => {
        calls.push({ api: "commands.unregister", args: [id] });
        commands.delete(id);
        return { ok: true };
      },
    },
    ui: {
      showToast: async (message, level) => {
        toasts.push({ message, level });
        calls.push({ api: "ui.showToast", args: [message, level] });
        return { ok: true };
      },
      notify: async (input) => {
        calls.push({ api: "ui.notify", args: [input] });
        return { ok: true };
      },
      openPanel: async (input) => {
        calls.push({ api: "ui.openPanel", args: [input] });
        return { ok: true };
      },
    },
    services: {
      register: (service) => {
        calls.push({ api: "services.register", args: [service] });
        services.set(service.id, service);
      },
      unregister: async (id) => {
        calls.push({ api: "services.unregister", args: [id] });
        const entry = services.get(id);
        services.delete(id);
        if (entry?.stop) await entry.stop();
      },
    },
    events: {
      on: (name, handler) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
        return () => listeners.get(name)?.delete(handler);
      },
      off: (name, handler) => {
        listeners.get(name)?.delete(handler);
      },
      emit: (name, payload) => {
        for (const handler of [...(listeners.get(name) ?? [])]) {
          try {
            handler(payload);
          } catch {
            /* a listener throwing must not stop the others */
          }
        }
      },
    },
    net: {
      fetch: async (input, init) => globalThis.fetch(input, init),
    },
    clipboard: {
      readText: async () => "",
      writeText: async () => ({ ok: true }),
    },
    shell: {
      openExternal: async () => ({ ok: true }),
    },
    app: {
      getVersion: async () => "0.21.0",
      getLocale: async () => "en",
      getAppearance: async () => "dark",
    },
    workspace: {
      get: async () => ({ root: process.cwd() }),
    },
    models: {
      list: async () => [],
    },
    agent: {
      registerTool: async () => ({ ok: true }),
      unregisterTool: async () => ({ ok: true }),
      complete: async () => ({ ok: true }),
    },
    bus: {
      publish: async () => ({ ok: true }),
      subscribe: async () => async () => {},
    },
  };

  return {
    host,
    dataDir,
    calls,
    commands,
    services,
    toasts,
    settings,
    emit: (name, payload) => host.events.emit(name, payload),
    cleanup() {
      if (options.dataDir || path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith("pi-perch-test-")) return;
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* the OS will reclaim it */
      }
    },
  };
}

/** Load the plugin with `pi` installed as a global. */
function loadPlugin(harness, pluginRoot) {
  // onLoad republishes the provider URL. Always test a disposable package copy.
  const isolatedRoot = path.join(harness.dataDir, "plugin");
  fs.cpSync(pluginRoot, isolatedRoot, { recursive: true });
  pluginRoot = isolatedRoot;
  const previous = globalThis.pi;
  globalThis.pi = harness.host;
  delete require.cache[require.resolve(path.join(pluginRoot, "main.js"))];
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(pluginRoot, "lib") + path.sep)) delete require.cache[key];
  }
  const plugin = require(path.join(pluginRoot, "main.js"));
  return {
    plugin,
    restore() {
      if (previous === undefined) delete globalThis.pi;
      else globalThis.pi = previous;
    },
  };
}

module.exports = { createHarness, loadPlugin };
