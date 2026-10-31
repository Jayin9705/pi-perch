"use strict";

/**
 * PI model provider backed by the official installed Perch CLI (ACP).
 * The loopback HTTP endpoint translates PI messages and tool requests into ACP
 * prompts. The CLI owns login/refresh; the plugin only reads the model catalog.
 * PI executes requested tools; ACP child processes cannot mutate the workspace.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { createCredentialStore } = require("./lib/auth");
const { createCatalogCache, findModel } = require("./lib/catalog");
const { PerchError } = require("./lib/upstream");
const { createCliClient } = require("./lib/cli");
const { createLoginController } = require("./lib/login");
const { createUsageCache } = require("./lib/usage");
const { mapModels, createMappingStore, saveMappingChanges } = require("./lib/mapping");
const { createModelUsageCache } = require("./lib/model-usage");
const { createLoopbackServer } = require("./lib/server");
const { PROVIDER_ID, PROVIDER_NAME, providerDeclaration, readDeclaredProviders, writeDeclaration } = require("./lib/declaration");

const LOG_PREFIX = "[pi-perch]";
const PREFERRED_PORT = 41891;
const SERVICE_ID = "perch-provider-host";
const DEFAULT_SETTINGS = {
  enabled: true,
  preferredPort: PREFERRED_PORT,
  refreshSeconds: 600,
};

/** Everything this load built, so a reload or an unload can tear it down. */
const runtime = {
  generation: 0,
  started: false,
  packageRoot: "",
  dataDir: "",
  settings: { ...DEFAULT_SETTINGS },
  credentials: null,
  catalog: null,
  upstream: null,
  login: null,
  usage: null,
  modelUsage: null,
  mapping: null,
  server: null,
  refreshTimer: null,
  settingsHandler: null,
  lastDeclaration: null,
  lastError: null,
  loadError: null,
};

function log(level, message) {
  const line = LOG_PREFIX + " " + String(message);
  try {
    if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    /* logging must never break a call */
  }
}

function safeMessage(error) {
  const text = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").slice(0, 400);
}

/**
 * The plugin's writable directory.
 *
 * `pi.plugin.getDataPath()` is the host's own answer and the right one; the
 * fallback exists so a test harness without a host still gets a stable place to
 * write, and it is under the same tree the host uses so nothing lands in temp.
 */
async function resolveDataDir() {
  try {
    if (typeof pi?.plugin?.getDataPath === "function") {
      const value = await pi.plugin.getDataPath();
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  } catch (error) {
    log("warn", "the plugin data path was not available: " + safeMessage(error));
  }
  try {
    const home = os.homedir();
    if (home) return path.join(home, ".pi-desktop", "plugins", "data", "local.pi-perch");
  } catch {
    /* no home */
  }
  return path.join(os.tmpdir(), "pi-perch");
}

/** The plugin's own package directory. `__dirname` is the root: main.js sits in it. */
function resolvePackageRoot() {
  try {
    return __dirname;
  } catch {
    return "";
  }
}

/** Read the plugin's settings document, defaulting per key. */
async function readSettings() {
  const merged = { ...DEFAULT_SETTINGS };
  try {
    const raw = typeof pi?.plugin?.getSettings === "function" ? await pi.plugin.getSettings() : null;
    if (raw && typeof raw === "object") {
      if (typeof raw.enabled === "boolean") merged.enabled = raw.enabled;
      const port = Number(raw.preferredPort);
      if (Number.isInteger(port) && port > 1024 && port < 65536) merged.preferredPort = port;
      const refresh = Number(raw.refreshSeconds);
      if (Number.isFinite(refresh) && refresh >= 60) merged.refreshSeconds = refresh;
    }
  } catch (error) {
    log("warn", "settings could not be read; using defaults: " + safeMessage(error));
  }
  return merged;
}

function pluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime.packageRoot || __dirname, "manifest.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * Publish the current catalog into the manifest.
 *
 * Never throws: a plugin whose manifest could not be rewritten still serves calls,
 * its model list is just whatever the last successful write left. The result is
 * kept for the panel, which is the only place a user can see why a model did not
 * appear.
 */
function publishDeclaration(catalog, baseUrl) {
  const rows=Array.isArray(catalog?.models)?catalog.models:[];
  if (!rows.length) {
    const result = { ok: false, changed: false, error: "the Perch catalog has no usable models; the previous declaration was kept" };
    runtime.lastDeclaration = { ...result, baseUrl, modelCount: 0, at: Date.now() };
    return result;
  }
  const selected=runtime.mapping?runtime.mapping.selected(rows):rows;
  // An explicit all-off selection removes the provider, rather than declaring
  // an invalid provider with no models or silently restoring every model.
  const declaration = providerDeclaration({...catalog,models:selected}, baseUrl);
  const result = writeDeclaration(runtime.packageRoot, declaration);
  runtime.lastDeclaration = { ...result, baseUrl, modelCount: selected.length, at: Date.now() };
  if (!result.ok) log("warn", "the provider declaration could not be published: " + String(result.error ?? "unknown"));
  return result;
}

/** Re-read the catalog and refresh the manifest declaration. */
async function refreshCatalog(options) {
  if (!runtime.credentials) return { ok: false, error: "the plugin is not loaded" };
  const credentials = await runtime.credentials.get();
  if (!credentials.ok) {
    runtime.lastError = credentials.error ?? "not signed in";
    return { ok: false, error: runtime.lastError, code: credentials.code ?? "not_signed_in" };
  }
  const catalog = await runtime.catalog.get(credentials, { force: options?.force === true });
  const baseUrl = runtime.server ? runtime.server.baseUrl() : "";
  const published = baseUrl ? publishDeclaration(catalog, baseUrl) : { ok: false, changed: false, error: "the server is not listening" };
  runtime.lastError = published.ok ? null : published.error ?? null;
  return {
    ok: published.ok,
    modelCount: catalog.models.length,
    lockedCount: catalog.lockedModels.length,
    published,
    error: published.error ?? null,
  };
}

/** Start the refresh loop, replacing any existing one. */
function scheduleRefresh(seconds) {
  if (runtime.refreshTimer) {
    clearInterval(runtime.refreshTimer);
    runtime.refreshTimer = null;
  }
  const ms = Math.max(60, Number(seconds) || DEFAULT_SETTINGS.refreshSeconds) * 1000;
  const timer = setInterval(() => {
    void refreshCatalog({ force: true }).catch((error) => {
      log("warn", "catalog refresh failed: " + safeMessage(error));
    });
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  runtime.refreshTimer = timer;
}

/**
 * React to a settings edit in the host's own UI.
 *
 * The host pushes a document when the user changes this plugin's settings; without
 * the listener those edits only take effect after a full reload. A port change is
 * the one edit that needs the server restarted, so that path rebinds and republishes.
 */
function subscribeToSettings() {
  unsubscribeFromSettings();
  const handler = (next) => {
    void (async () => {
      const previous = runtime.settings;
      const merged = { ...previous };
      if (next && typeof next === "object") {
        if (typeof next.enabled === "boolean") merged.enabled = next.enabled;
        const port = Number(next.preferredPort);
        if (Number.isInteger(port) && port > 1024 && port < 65536) merged.preferredPort = port;
        const refresh = Number(next.refreshSeconds);
        if (Number.isFinite(refresh) && refresh >= 60) merged.refreshSeconds = refresh;
      }
      runtime.settings = merged;
      if (merged.refreshSeconds !== previous.refreshSeconds) scheduleRefresh(merged.refreshSeconds);
      if (merged.enabled !== previous.enabled) {
        if (merged.enabled) await startServing();
        else await stopServing();
        return;
      }
      if (merged.preferredPort !== previous.preferredPort && merged.enabled) {
        await stopServing();
        await startServing();
      }
    })().catch((error) => log("warn", "applying settings failed: " + safeMessage(error)));
  };
  runtime.settingsHandler = handler;
  try {
    if (pi?.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", handler);
      return true;
    }
  } catch (error) {
    log("warn", "settings changes could not be subscribed to: " + safeMessage(error));
  }
  runtime.settingsHandler = null;
  return false;
}

function unsubscribeFromSettings() {
  const handler = runtime.settingsHandler;
  runtime.settingsHandler = null;
  if (handler === null) return;
  try {
    if (pi?.events && typeof pi.events.off === "function") pi.events.off("plugin:settingsChanged", handler);
  } catch (error) {
    log("warn", "settings changes could not be unsubscribed from: " + safeMessage(error));
  }
}

/**
 * Start the loopback server and publish its declaration.
 *
 * The server starts even when the sign-in is missing: PI asks for the model list on
 * load, and an endpoint that answers "not signed in" is more useful than a provider
 * whose base URL refuses connections. A missing sign-in therefore leaves the plugin
 * running with an empty catalog and an explanation, not in `load_error`.
 */
async function startServing() {
  if (runtime.server) return { ok: true, already: true };
  const generation = runtime.generation;
  const server = createLoopbackServer({
    log,
    port: runtime.settings.preferredPort,
    version: pluginVersion(),
    upstream: runtime.upstream,
    modelVisible: row => runtime.mapping?.isEnabled(row.id) !== false,
    catalog: async () => {
      const creds = await runtime.credentials.get();
      if (!creds.ok) {
        throw new PerchError(creds.error ?? "not signed in", { code: creds.code ?? "not_signed_in", status: 401 });
      }
      return runtime.catalog.get(creds);
    },
  });
  await server.ready;
  // A teardown that landed while the port was binding must not leave this server
  // running with nobody holding a reference to close it.
  if (generation !== runtime.generation) {
    await server.close().catch(() => {});
    return { ok: false, error: "the plugin was unloaded while the server was starting" };
  }
  runtime.server = server;
  runtime.started = true;
  const refreshed = await refreshCatalog({ force: true }).catch((error) => ({ ok: false, error: safeMessage(error) }));
  if (!refreshed.ok) {
    log("warn", "started without a model list: " + String(refreshed.error ?? "unknown"));
    runtime.lastError = refreshed.error ?? null;
  }
  log("info", "serving " + (refreshed.modelCount ?? 0) + " models on " + server.baseUrl());
  scheduleRefresh(runtime.settings.refreshSeconds);
  return refreshed;
}

async function stopServing() {
  if (runtime.refreshTimer) {
    clearInterval(runtime.refreshTimer);
    runtime.refreshTimer = null;
  }
  if (runtime.server) {
    try {
      await runtime.server.close();
    } catch (error) {
      log("warn", "the server did not close cleanly: " + safeMessage(error));
    }
    runtime.server = null;
  }
  runtime.started = false;
}

async function onLoad() {
  runtime.generation += 1;
  const generation = runtime.generation;
  runtime.settings = await readSettings();
  runtime.packageRoot = resolvePackageRoot();
  runtime.dataDir = await resolveDataDir();
  runtime.mapping = createMappingStore(runtime.dataDir);
  try {
    fs.mkdirSync(runtime.dataDir, { recursive: true });
  } catch {
    /* the host may have already created it */
  }

  const upstream = createCliClient({ dataDir: runtime.dataDir, log });
  const credentials = createCredentialStore({ refreshSession: () => upstream.refreshSession(), isReady: () => upstream.runtimeStatus().state === "ready" });
  const catalog = createCatalogCache({ log });

  runtime.credentials = credentials;
  runtime.usage = createUsageCache({credentials});
  runtime.modelUsage = createModelUsageCache({credentials,usage:runtime.usage,catalog});
  runtime.catalog = catalog;
  runtime.upstream = upstream;
  runtime.login = createLoginController({prepare:()=>upstream.prepare(),current:()=>credentials.current(),onSuccess:()=>refreshCatalog({force:true})});

  // The service is what keeps the provider alive between turns: without a
  // `background.service` the host would stop the plugin process and the base URL
  // would go dark while the model list still pointed at it.
  try {
    if (typeof pi?.services?.register === "function") {
      pi.services.register({ id: SERVICE_ID, start: onServiceStart, stop: onServiceStop });
    }
  } catch (error) {
    log("warn", "the background service could not be registered: " + safeMessage(error));
  }

  subscribeToSettings();
  if (generation !== runtime.generation) return;

  if (!runtime.settings.enabled) {
    log("info", "disabled in settings; nothing started");
    return;
  }

  void upstream.prepare().then(() => refreshCatalog({force:true})).catch(error => {
    runtime.lastError = safeMessage(error);
    log("warn", "runtime setup: " + safeMessage(error));
  });

  await startServing();
  scheduleRefresh(runtime.settings.refreshSeconds);

  try {
    await pi.commands.register({
      id: "pi-perch.refresh",
      title: "Perch: refresh the model list",
      run: async () => {
        runtime.catalog.invalidate();
        const result = await refreshCatalog({ force: true });
        const suffix = result.published?.changed ? " - reload the plugin to pick up new models" : "";
        await pi.ui.showToast("Perch: " + (result.modelCount ?? 0) + " models" + suffix);
        return result;
      },
    });
  } catch (error) {
    log("warn", "the refresh command could not be registered: " + safeMessage(error));
  }
}

async function onServiceStart() {
  if (!runtime.settings.enabled) return;
  if (runtime.server) return;
  await startServing().catch((error) => log("warn", "the provider server could not be started: " + safeMessage(error)));
}

async function onServiceStop() {
  await stopServing();
}

async function onUnload() {
  runtime.generation += 1;
  runtime.login?.cancel();
  unsubscribeFromSettings();
  try {
    await pi.commands.unregister("pi-perch.refresh");
  } catch {
    /* it may never have registered */
  }
  // Publish once more so a selection changed in the host's settings UI reaches the
  // picker on the next enable instead of needing a second round.
  try {
    const catalog = runtime.catalog?.peek();
    const baseUrl = runtime.server?.baseUrl();
    if (catalog && baseUrl) publishDeclaration(catalog, baseUrl);
  } catch (error) {
    log("warn", "the declaration could not be published during unload: " + safeMessage(error));
  }
  await stopServing();
  await runtime.upstream?.close();
}

/**
 * Panel operations.
 *
 * The panel is a webview: it cannot call `pi` directly, only the fixed bridge
 * channels. Anything richer than those channels arrives here through
 * `window.pluginBridge.invoke(channel, payload)`, which the host routes to
 * `onPanelInvoke`.
 */
async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "perch.setup": {
      void runtime.upstream.prepare().then(()=>refreshCatalog({force:true})).catch(error=>{runtime.lastError=safeMessage(error);});
      return {ok:true,runtime:runtime.upstream.runtimeStatus()};
    }
    case "perch.login": return runtime.login.start(payload?.provider || "google");
    case "perch.login.cancel": return runtime.login.cancel();
    case "perch.usage": return runtime.usage.get({force:payload?.force===true});
    case "perch.modelUsage": return runtime.modelUsage.get({force:payload?.force===true});
    case "perch.mapping.save": {
      const credentials=await runtime.credentials.get();
      if(!credentials.ok)return {ok:false,error:credentials.error};
      const catalog=await runtime.catalog.get(credentials);
      if(!runtime.server)return {ok:false,error:"请先启用插件，再修改模型映射。"};
      return saveMappingChanges(runtime.mapping,catalog.models,payload?.changes,()=>publishDeclaration(catalog,runtime.server.baseUrl()));
    }
    case "perch.status": {
      const credentials = runtime.credentials ? await runtime.credentials.get() : { ok: false, error: "the plugin is not loaded" };
      const catalog = runtime.catalog?.peek() ?? null;
      return {
        ok: true,
        started: runtime.started,
        version: pluginVersion(),
        baseUrl: runtime.server ? runtime.server.baseUrl() : "",
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        transport: "official-cli-acp",
        runtime: runtime.upstream?.runtimeStatus(),
        login: runtime.login?.status(),
        signedIn: credentials.ok === true,
        email: credentials.ok ? credentials.email ?? "" : "",
        signInError: credentials.ok ? null : credentials.error ?? null,
        tokenExpiresAt: credentials.ok ? credentials.expiresAt ?? 0 : 0,
        catalogAgeSeconds: catalog ? Math.round((Date.now() - catalog.fetchedAt) / 1000) : null,
        modelCount: catalog?.models?.length ?? 0,
        lockedCount: catalog?.lockedModels?.length ?? 0,
        declaration: runtime.lastDeclaration,
        lastError: runtime.lastError,
      };
    }
    case "perch.models": {
      const credentials = await runtime.credentials.get();
      if (!credentials.ok) return { ok: false, error: credentials.error ?? "not signed in", code: credentials.code ?? "not_signed_in" };
      const catalog = await runtime.catalog.get(credentials, { force: payload?.force === true });
      if (payload?.force && runtime.server) publishDeclaration(catalog,runtime.server.baseUrl());
      let hostModels=[], mappingError=null;
      try {hostModels=await pi.models.list();}catch(error){mappingError=safeMessage(error);}
      const mapping=mapModels(catalog.models.map(summariseModel),hostModels,mappingError,runtime.mapping.disabledIds());
      return {
        ok: true,
        fetchedAt: catalog.fetchedAt,
        canPickModel: catalog.canPickModel,
        effortUnlocked: catalog.effortUnlocked,
        tiers: catalog.tiers,
        models: mapping.models,
        mapping: {providerId:mapping.providerId,verified:mapping.verified,error:mapping.error,registeredCount:mapping.registeredCount,selectedCount:mapping.selectedCount,requiresReload:mapping.requiresReload},
        lockedModels: catalog.lockedModels.map(summariseModel),
      };
    }
    case "perch.refresh": {
      runtime.catalog.invalidate();
      return refreshCatalog({ force: true });
    }
    case "perch.test": {
      const credentials = await runtime.credentials.get();
      if (!credentials.ok) return { ok: false, error: credentials.error ?? "not signed in", code: credentials.code ?? "not_signed_in" };
      const catalog = await runtime.catalog.get(credentials);
      const row = findModel(catalog, payload?.model) ?? catalog.models[0];
      if (!row) return { ok: false, error: "the Perch catalog has no usable model" };
      const pin = row.pin;
      if (!pin?.verified) return {ok:false,error:"此模型尚未匹配 CLI，请更新插件和 Perch CLI。"};
      const startedAt = Date.now();
      try {
        const answer = await runtime.upstream.call(
          {
            request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 32 },
            manualModelOptionId: pin.optionId,
          },
          { timeoutMs: 60000 },
        );
        runtime.usage.invalidate();
        return {
          ok: true,
          model: row.id,
          label: row.label,
          optionId: pin.optionId,
          transport: "official-cli-acp",
          provider: answer.provider,
          text: String(answer.text ?? "").slice(0, 200),
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          ok: false,
          model: row.id,
          label: row.label,
          optionId: pin.optionId,
          status: Number(error?.status) || 0,
          code: error?.code ?? "perch_error",
          error: safeMessage(error),
          limit: error?.limit ?? null,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    case "perch.diagnostics": {
      const credentials = runtime.credentials ? runtime.credentials.current() : { ok: false };
      return {
        ok: true,
        signedIn: credentials.ok === true,
        credentialSource: credentials.ok ? credentials.source ?? "unknown" : null,
        tokenExpiresAt: credentials.ok ? credentials.expiresAt ?? 0 : 0,
        baseUrl: runtime.server ? runtime.server.baseUrl() : "",
        declared: readDeclaredProviders(runtime.packageRoot).map((provider) => ({
          id: provider?.id,
          baseUrl: provider?.baseUrl,
          models: Array.isArray(provider?.models) ? provider.models.length : 0,
        })),
        settings: runtime.settings,
        dataDir: runtime.dataDir,
        lastDeclaration: runtime.lastDeclaration,
        lastError: runtime.lastError,
        loadError: runtime.loadError,
        cli: runtime.upstream?.diagnostics(),
      };
    }
    default:
      return { ok: false, error: "unknown panel channel: " + String(channel ?? "") };
  }
}

function summariseModel(row) {
  return {
    id: row.id,
    label: row.label,
    group: row.group,
    locked: row.locked,
    requires: row.requires,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    thinkingLevels: row.thinkingLevels,
    defaultThinkingLevel: row.defaultThinkingLevel,
    keepsData: row.keepsData,
    retentionNotice: row.retentionNotice,
    optionId: row.pin?.optionId ?? null,
    pinVerified: row.pin?.verified === true,
  };
}

/**
 * A declared provider with `authKind: "oauth"` obliges the plugin to expose this
 * hook. Perch's sign-in comes from the CLI, not from an OAuth flow the plugin can
 * drive, so this answers with the instruction that actually works rather than
 * pretending to start a flow that would fail.
 */
async function onProviderOAuth() {
  const error = new Error("请打开 Perch Bridge 面板，点击登录 Perch。");
  error.code = "UNSUPPORTED";
  throw error;
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  onProviderOAuth,
  onServiceStart,
  onServiceStop,
  _runtime: runtime,
  _readDeclaredProviders: readDeclaredProviders,
  _refreshCatalog: refreshCatalog,
  _startServing: startServing,
  _stopServing: stopServing,
};
