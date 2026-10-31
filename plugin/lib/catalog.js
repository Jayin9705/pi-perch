"use strict";

/** Read the account model catalog and map its ids to official CLI selections. */

const PERCH_APP_URL = "https://app.perchai.app";
const MODELS_PATH = "/api/perchai/models";
const CATALOG_TTL_MS = 10 * 60 * 1000;

/**
 * Catalog id -> the backend pair Perch routes it to.
 *
 * `served` is the model string the model-call endpoint echoed for that pin during
 * verification; it is what the plugin checks a live answer against.
 */
const PIN_TABLE = {
  "deepseek-flash-starter": { optionId: "openrouter-deepseek-deepseek-v4-1-flash-1017-cloudflare", served: "deepseek/deepseek-v4.1-flash" },
  "glm-5.3-flash-starter": { optionId: "openrouter-z-ai-glm-5-3-flash", served: "z-ai/glm-5.3-flash" },
  "qwen-3.8-max": { optionId: "openrouter-qwen-qwen3-8-max-0902", served: "Qwen/Qwen3.8-Max" },
  "gemini-4-argon": { optionId: "gemini-gemini-4-argon", served: "google/gemini-4-argon" },
  "claude-opus-5.5": { optionId: "anthropic-claude-opus-5-5", served: "claude-opus-5-5" },
  "gpt-6.1-sol": { optionId: "azure-foundry-gpt-6-1-sol", served: "gpt-6.1-sol" },
  "gpt-6.1-terra": { optionId: "azure-foundry-gpt-6-1-terra", served: "gpt-6.1-terra" },
  "kimi-3.1-pro": { optionId: "openrouter-moonshotai-kimi-k3-1-pro", served: "moonshotai/kimi-k3.1-pro" },
  "deepseek-v4.1-flash-1017": { optionId: "openrouter-deepseek-deepseek-v4-1-flash-1017", served: "deepseek/deepseek-v4.1-flash" },
  "gpt-6-luna": { optionId: "azure-foundry-gpt-6-luna", served: "gpt-6-luna" },
  "claude-sonnet-5.5": { optionId: "anthropic-claude-sonnet-5-5", served: "claude-sonnet-5-5" },
  "claude-haiku-5.5": { optionId: "anthropic-claude-haiku-5-5", served: "claude-haiku-5-5" },
  "kimi-3": { optionId: "azure-foundry-fw-kimi-k3", served: "kimi-k3" },
  "grok-4.7": { optionId: "azure-foundry-grok-4-7", served: "grok-4.7" },
  "grok-4.6": { optionId: "bedrock-mantle-xai-grok-4-6", served: "xai.grok-4.6" },
  "glm-5.3": { optionId: "azure-foundry-fw-glm-5-3", served: "z-ai/glm-5.3" },
  "glm-5.3-flash": { optionId: "wandb-zai-org-glm-5-3-flash", served: "z-ai/glm-5.3-flash" },
  "qwen-3.8-flash": { optionId: "openrouter-qwen-qwen3-8-flash", served: "Qwen/Qwen3.8-Flash" },
  "qwen-3.8": { optionId: "wandb-qwen-qwen3-8-27b", served: "Qwen/Qwen3.8-27B" },
  "minimax-m3": { optionId: "wandb-minimax-m3", served: "MiniMaxAI/MiniMax-M3" },
  "nemotron-ultra": { optionId: "wandb-nvidia-nvidia-nemotron-3-ultra-550b-a55b", served: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B" },
  "nemotron-lightning": { optionId: "wandb-nvidia-nvidia-nemotron-3-5-lightning-30b-a3b", served: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B" },
  "deepseek-v4": { optionId: "wandb-deepseek-ai-deepseek-v4-pro", served: "deepseek/deepseek-v4-pro" },
  "deepseek-v4-flash-0731-262k": { optionId: "wandb-deepseek-ai-deepseek-v4-flash-0731", served: "deepseek/deepseek-v4-flash" },
  "qwen-3.7-plus": { optionId: "fireworks-accounts-fireworks-models-qwen3p7-plus", served: "accounts/fireworks/models/qwen3p7-plus" },
  inkling: { optionId: "fireworks-accounts-fireworks-models-inkling", served: "inkling" },
  "beam-1.0": { optionId: "wandb-reflection-beam-1-0-501b-a23b", served: "reflection/Beam-1.0-501B-A23B" },
  "kimi-2.7": { optionId: "wandb-kimi-k2-7-code", served: "kimi-k2-7-code" },
  "glm-5.2": { optionId: "wandb-zai-org-glm-5-2", served: "zai-org/GLM-5.2" },
  "gpt-6-sol": { optionId: "azure-foundry-gpt-6-sol", served: "gpt-6-sol" },
  "gpt-5.6-sol": { optionId: "azure-foundry-gpt-5-6-sol", served: "gpt-5-6-sol" },
  "gpt-5.6-terra": { optionId: "azure-foundry-gpt-5-6-terra", served: "gpt-5-6-terra" },
  "gpt-5.6-luna": { optionId: "azure-foundry-gpt-5-6-luna", served: "gpt-5-6-luna" },
  "claude-fable-5.1": { optionId: "openrouter-anthropic-claude-fable-5-1", served: "claude-fable-5.1" },
  "gpt-6-astra": { optionId: "azure-foundry-gpt-6-astra", served: "gpt-6-astra" },
};

/** The CLI's own folding rule, for rows the table does not carry. */
function foldOptionId(providerId, modelId) {
  const provider = String(providerId ?? "").replace(/_/g, "-");
  const model = String(modelId ?? "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return provider + "-" + model;
}

/**
 * The pin for a catalog id.
 *
 * Known rows use the verified table. An unknown row is pinned by asking each
 * backend in turn, which is what `resolveUnknownPin` does; without that it falls
 * back to the id itself so the request still names a model the server may know.
 */
function pinFor(catalogId) {
  const known = PIN_TABLE[catalogId];
  if (known) return { optionId: known.optionId, served: known.served, verified: true };
  return { optionId: String(catalogId ?? ""), served: null, verified: false };
}

/** Every backend prefix the CLI bundle pairs with a model id. */
const BACKEND_PROVIDERS = [
  "azure_foundry",
  "anthropic",
  "openrouter",
  "wandb",
  "dashscope",
  "bedrock_mantle",
  "fireworks",
  "gemini",
  "nvidia_nim",
  "z_ai",
  "meta",
  "poolside",
  "snowflake",
  "claude_code_oauth",
  "codex_oauth",
  "grok_oauth",
  "ai_gateway",
];

/**
 * Candidate pins for a catalog id with no table row.
 *
 * A catalog id is usually the model's own name, so each backend paired with that
 * name is a plausible pin; `served`-matching at call time decides which one is
 * real. The list is ordered so the backends that served the most catalog rows come
 * first, which keeps the wasted probes to a minimum.
 */
function candidatePins(catalogId) {
  const id = String(catalogId ?? "");
  if (id === "") return [];
  return BACKEND_PROVIDERS.map((provider) => foldOptionId(provider, id));
}

/** Normalise the effort ladder Perch reports into the levels PI understands. */
const PI_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

function normalizeEffortLevels(model) {
  const raw = Array.isArray(model?.effort?.levels) ? model.effort.levels : [];
  const kept = raw.filter((level) => PI_EFFORT_LEVELS.includes(level));
  return kept.length > 0 ? kept : [];
}

/**
 * Turn one `/api/perchai/models` row into a model the plugin can advertise.
 *
 * `id` stays the catalog id so a PI model picker shows the name the user sees in
 * Perch, and the pin is looked up from the table when a request arrives. Locked
 * rows are kept in the catalog (the panel shows why they are unavailable) but the
 * manifest declaration leaves them out: advertising a model that always answers
 * 403 turns every selection into a failed turn.
 */
function modelFromCatalogRow(row, options) {
  const includeLocked = options?.includeLocked === true;
  if (!row || typeof row !== "object") return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (id === "") return null;
  const locked = row.locked === true;
  if (locked && !includeLocked) return null;
  const label = typeof row.label === "string" && row.label.trim() !== "" ? row.label.trim() : id;
  const contextWindow = Number(row.contextTokens) > 0 ? Number(row.contextTokens) : 200000;
  const levels = normalizeEffortLevels(row);
  const group = typeof row.group === "string" ? row.group : "models";
  return {
    id,
    name: label,
    label,
    group,
    locked,
    requires: typeof row.requires === "string" ? row.requires : null,
    keepsData: row.keepsData === true,
    retentionNotice: typeof row.retentionNotice === "string" ? row.retentionNotice : null,
    contextWindow,
    // Perch bills by the turn, not by a per-response token cap; a generous ceiling
    // keeps PI from truncating an answer the server was willing to finish.
    maxTokens: Math.min(128000, Math.max(8192, Math.floor(contextWindow / 8))),
    thinkingLevels: levels,
    defaultThinkingLevel: levels.includes("medium") ? "medium" : levels[levels.length - 1] ?? "off",
    supportsImages: true,
    alias: label,
    pin: pinFor(id),
  };
}

function createCatalogCache(options) {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const log = options?.log ?? (() => {});
  let cached = null;
  let inFlight = null;

  async function fetchCatalog(credentials) {
    const appUrl = credentials?.appUrl || PERCH_APP_URL;
    const res = await fetchImpl(appUrl.replace(/\/+$/, "") + MODELS_PATH, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + credentials.accessToken,
        "User-Agent": "pi-perch/0.2.0",
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const error = new Error("the Perch model catalog could not be read (" + res.status + ")");
      error.code = res.status === 401 ? "reauth_required" : "catalog_failed";
      error.detail = text.slice(0, 300);
      throw error;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const error = new Error("the Perch model catalog returned a body that is not JSON");
      error.code = "catalog_failed";
      throw error;
    }
    const rows = Array.isArray(body?.models) ? body.models : [];
    const tiers = Array.isArray(body?.tiers) ? body.tiers : [];
    const models = rows.map((row) => modelFromCatalogRow(row)).filter((model) => model !== null);
    const lockedModels = rows
      .filter((row) => row?.locked === true)
      .map((row) => modelFromCatalogRow(row, { includeLocked: true }))
      .filter((model) => model !== null);
    return {
      fetchedAt: Date.now(),
      appUrl,
      tiers,
      canPickModel: body?.canPickModel === true,
      effortUnlocked: body?.effortUnlocked === true,
      models,
      lockedModels,
      allModels: [...models, ...lockedModels],
    };
  }

  /**
   * The catalog, from cache when it is fresh.
   *
   * A stale cache is still served when a refresh fails: a model list that is ten
   * minutes old beats an empty one, and the model call reports the real problem.
   */
  async function get(credentials, options2) {
    const force = options2?.force === true;
    if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
    if (inFlight === null) {
      inFlight = fetchCatalog(credentials)
        .then((next) => {
          cached = next;
          return next;
        })
        .catch((error) => {
          log("warn", "perch catalog fetch failed: " + String(error?.code ?? error?.message ?? error));
          if (cached) return cached;
          throw error;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  function peek() {
    return cached;
  }

  function invalidate() {
    cached = null;
  }

  return { get, peek, invalidate };
}

/** Locate a catalog row by any of its identifiers. */
function findModel(catalog, wanted) {
  const needle = String(wanted ?? "").trim();
  if (needle === "") return null;
  const rows = [...(catalog?.models ?? []), ...(catalog?.lockedModels ?? [])];
  const exact = rows.find((row) => row.id === needle);
  if (exact) return exact;
  const lower = needle.toLowerCase();
  const byLabel = rows.find((row) => row.label.toLowerCase() === lower);
  if (byLabel) return byLabel;
  const byId = rows.find((row) => row.id.toLowerCase() === lower);
  if (byId) return byId;
  const byPin = rows.find((row) => row.pin?.optionId === needle);
  if (byPin) return byPin;
  return null;
}

module.exports = {
  BACKEND_PROVIDERS,
  CATALOG_TTL_MS,
  MODELS_PATH,
  PERCH_APP_URL,
  PIN_TABLE,
  PI_EFFORT_LEVELS,
  candidatePins,
  createCatalogCache,
  findModel,
  foldOptionId,
  modelFromCatalogRow,
  normalizeEffortLevels,
  pinFor,
};
