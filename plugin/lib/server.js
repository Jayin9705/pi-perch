"use strict";

/**
 * The loopback OpenAI-compatible server PI-Desktop talks to.
 *
 * A plugin cannot hand the host a request handler; the only channel is
 * `contributes.providers` in the manifest, which names a `baseUrl`. So the plugin
 * runs its own HTTP server on 127.0.0.1 and declares that address as the provider's
 * base URL. The host then calls `/v1/chat/completions` here exactly as it would call
 * OpenAI, and this server translates to Perch and back.
 *
 * Bind rules:
 *  - 127.0.0.1 only, never a wildcard address: this server carries a live
 *    credential and must not be reachable from the network.
 *  - A fixed port is preferred so the manifest declaration stays stable across
 *    restarts; if it is taken, startup fails clearly. The provider must never point
 *    at an unrelated process or a stale ephemeral port.
 *  - Every request is checked for a loopback `Host` and a loopback-or-absent
 *    `Origin`, so a page in a browser cannot drive the endpoint.
 */

const http = require("node:http");
const { PerchError } = require("./upstream");
const {
  buildModelCallBody,
  completionFromAnswer,
  translateMessages,
  translateTools,
} = require("./adapter");
const { createStreamTranslator } = require("./stream");
const { findModel } = require("./catalog");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const NO_AUTH_SENTINEL = "pi-desktop-no-auth";

function hostnameOf(hostHeader) {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (raw === "") return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(raw.slice(colon + 1))) return raw.slice(0, colon);
  return raw;
}

function hostIsLoopback(hostHeader) {
  const hostname = hostnameOf(hostHeader);
  if (hostname === "") return false;
  return LOOPBACK_HOSTS.has(hostname);
}

function originIsLoopback(origin) {
  if (origin === undefined || String(origin).trim() === "") return true;
  try {
    const { hostname } = new URL(String(origin));
    return LOOPBACK_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

function writeJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders ?? {},
  });
  res.end(payload);
}

function writeOpenAIError(res, status, message, code, extra) {
  writeJson(res, status, {
    error: {
      message: String(message ?? "the request failed").slice(0, 2000),
      type: code ?? "perch_error",
      code: code ?? "perch_error",
      ...extra ?? {},
    },
  });
}

function readBody(req, limitBytes = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        const error = new Error("request body too large");
        error.code = "body_too_large";
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (error) => reject(error));
  });
}

/**
 * An HTTP status for a Perch failure.
 *
 * PI's adapter retries 429 and 5xx on its own, so the mapping matters: a plan
 * refusal (403) must not look retryable, while a quota ceiling (429) should, because
 * the host backs off and the user may have quota by then.
 */
function statusForError(error) {
  if (!(error instanceof PerchError)) return 502;
  if (error.code === "aborted") return 499;
  if (error.status > 0) return error.status;
  if (error.code === "reauth_required" || error.code === "not_authenticated") return 401;
  if (error.code === "plan_model_blocked" || error.code === "starter_model_blocked") return 403;
  if (error.code === "usage_limit_reached" || error.code === "turn_rate_limited") return 429;
  return error.retryable ? 502 : 400;
}

/** The model list this server answers on `/v1/models`. */
function modelsPayload(catalog) {
  const rows = Array.isArray(catalog?.models) ? catalog.models : [];
  return {
    object: "list",
    data: rows.map((model) => ({
      id: model.id,
      object: "model",
      created: Math.floor((catalog?.fetchedAt ?? Date.now()) / 1000),
      owned_by: "perch",
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
    })),
  };
}

/**
 * Start the server.
 *
 * `options.handleChat` receives a parsed request and returns either a completion
 * object or an object `{ stream: true, body }` carrying a web ReadableStream of
 * OpenAI SSE text. Keeping that decision outside the server means the chat logic
 * lives in one place and the server stays a transport.
 */
function createLoopbackServer(options) {
  const logger = options?.log ?? (() => {});
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      logger("warn", "perch loopback request failed: " + String(error?.message ?? error).slice(0, 300));
      if (!res.headersSent) {
        writeOpenAIError(res, statusForError(error), error?.message ?? "the request failed", error?.code ?? "perch_error");
      } else {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // Guards first: an unauthenticated caller gets no information about the routes.
    if (!hostIsLoopback(req.headers.host)) {
      writeOpenAIError(res, 403, "this endpoint only answers on the loopback address", "forbidden_host");
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeOpenAIError(res, 403, "this endpoint refuses cross-origin callers", "forbidden_origin");
      return;
    }

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      const catalog = options.catalog ? await options.catalog().catch(() => null) : null;
      const visible=options.modelVisible && catalog ? {...catalog,models:catalog.models.filter(options.modelVisible)} : catalog;
      writeJson(res, 200, modelsPayload(visible));
      return;
    }

    if (req.method === "GET" && (pathname === "/health" || pathname === "/v1/health")) {
      writeJson(res, 200, { ok: true, service: "pi-perch", upstream: "perch", version: options.version ?? "0.1.0" });
      return;
    }

    if (req.method !== "POST") {
      writeOpenAIError(res, 405, "method not allowed", "method_not_allowed");
      return;
    }

    const isChat = pathname === "/v1/chat/completions" || pathname === "/chat/completions";
    if (!isChat) {
      writeOpenAIError(res, 404, "no such route: " + pathname, "not_found");
      return;
    }

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      writeOpenAIError(res, 400, "the request body is not JSON", "invalid_json");
      return;
    }
    if (!body || typeof body !== "object") {
      writeOpenAIError(res, 400, "the request body must be an object", "invalid_body");
      return;
    }

    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    if (requestedModel === "") {
      writeOpenAIError(res, 400, "the request body has no model", "missing_model");
      return;
    }

    const catalog = options.catalog ? await options.catalog().catch(() => null) : null;
    const row = findModel(catalog, requestedModel);
    if (!row) {
      const known = Array.isArray(catalog?.models) ? catalog.models.length : 0;
      writeOpenAIError(
        res,
        404,
        "the model " + requestedModel + " is not in the Perch catalog" + (known > 0 ? " (" + known + " available)" : "") + "; refresh the plugin's model list",
        "model_not_found",
      );
      return;
    }
    if (row.locked) {
      const needs = row.requires ? " (needs the " + row.requires + " plan)" : "";
      writeOpenAIError(res, 403, row.label + " is not on this plan" + needs, "plan_model_blocked");
      return;
    }

    if (!row.pin?.verified) {
      writeOpenAIError(res, 400, "此模型尚未匹配 CLI，请更新插件和 Perch CLI。", "cli_model_unmapped");
      return;
    }
    const translated = translateMessages(body.messages);
    if (translated.messages.length === 0) {
      writeOpenAIError(res, 400, "the request carried no usable messages", "empty_messages");
      return;
    }
    const tools = translateTools(body.tools);
    const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
    const temperature = typeof body.temperature === "number" ? body.temperature : undefined;
    const thinkingLevel = typeof body.reasoning_effort === "string" ? body.reasoning_effort : typeof body.thinking === "string" ? body.thinking : "";

    const upstreamBody = buildModelCallBody({
      messages: translated.messages,
      system: translated.system,
      tools,
      maxTokens,
      temperature,
      pin: row.pin?.optionId,
      thinkingLevel,
      allowedLevels: row.thinkingLevels,
    });

    upstreamBody.request.toolChoice = body.tool_choice;
    const wantsStream = body.stream === true;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    if (wantsStream) {
      const { res: upstreamRes } = await options.upstream.stream(upstreamBody, { signal: abort.signal });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      res.flushHeaders();
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": waiting for Perch CLI\n\n"); }, 15000);
      const translator = createStreamTranslator({ model: requestedModel, includeUsage: true });
      const reader = upstreamRes.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const out = translator.push(value);
          if (out !== "") {
            if (res.writableEnded) break;
            res.write(out);
          }
        }
        const tail = translator.end();
        if (tail !== "" && !res.writableEnded) res.write(tail);
      } finally {
        clearInterval(heartbeat);
        try {
          await reader.cancel();
        } catch {
          /* the upstream is already gone */
        }
        try {
          reader.releaseLock();
        } catch {
          /* nothing held */
        }
        if (!res.writableEnded) res.end();
      }
      return;
    }

    const answer = await options.upstream.call(upstreamBody, { signal: abort.signal });
    const completion = completionFromAnswer(answer, { model: requestedModel });
    writeJson(res, 200, completion);
  }

  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const requestedPort = Number.isInteger(options?.port) && options.port >= 0 ? options.port : 41891;
  server.listen(requestedPort, "127.0.0.1");
  server.on("error", (error) => {
    logger("warn", "perch loopback server error: " + String(error?.message ?? error).slice(0, 200));
  });

  return {
    ready,
    port() {
      const address = server.address();
      return address === null || typeof address === "string" ? 0 : address.port;
    },
    baseUrl() {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("the loopback server is not listening");
      return "http://127.0.0.1:" + address.port;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  BODY_LIMIT_BYTES,
  LOOPBACK_HOSTS,
  NO_AUTH_SENTINEL,
  createLoopbackServer,
  hostIsLoopback,
  modelsPayload,
  originIsLoopback,
  statusForError,
  writeJson,
  writeOpenAIError,
};
