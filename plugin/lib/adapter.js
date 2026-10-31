"use strict";

/** Normalize PI messages/tools for the official CLI bridge and frame replies. */

const crypto = require("node:crypto");

/** A stable id for a tool call that arrived without one. */
function newCallId() {
  return "call_" + crypto.randomBytes(12).toString("hex");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Parse an image URL into a Perch image block.
 *
 * A data URL carries its media type and payload inline; a plain URL is passed as
 * a source of type "url". Anything else is dropped rather than sent malformed.
 */
function imageBlock(url) {
  const raw = String(url ?? "").trim();
  if (raw === "") return null;
  const dataMatch = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(raw);
  if (dataMatch) {
    const mediaType = dataMatch[1] || "image/png";
    const data = dataMatch[2] ?? "";
    if (data === "") return null;
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  if (/^https?:\/\//i.test(raw)) return { type: "image", source: { type: "url", url: raw } };
  return null;
}

/** One OpenAI content part into a Perch content block. */
function contentBlockOf(part) {
  if (typeof part === "string") return { type: "text", text: part };
  if (!part || typeof part !== "object") return null;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "text" || type === "input_text") {
    const text = typeof part.text === "string" ? part.text : "";
    return text === "" ? null : { type: "text", text };
  }
  if (type === "image_url" || type === "input_image") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    return imageBlock(url);
  }
  // Already a Perch/Anthropic block, passed through by a client that speaks it.
  if (type === "image" && part.source) return { type: "image", source: part.source };
  if (type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: String(part.tool_use_id ?? part.tool_call_id ?? ""),
      content: textOf(part.content),
    };
  }
  return null;
}

function contentBlocksOf(content) {
  const parts = Array.isArray(content) ? content : [content];
  const blocks = [];
  for (const part of parts) {
    const block = contentBlockOf(part);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** Arguments arrive as an object from PI and as a JSON string from OpenAI clients. */
function argumentsObjectOf(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Translate the OpenAI `messages` array into the shape Perch's endpoint accepts.
 *
 * Perch's endpoint takes OpenAI messages and converts them to each backend's
 * protocol itself. Two normalisations are all that is needed:
 *
 *  1. `assistant.content` becomes `""` when it was `null`, because a backend
 *     iterating over a null content crashes ("e is not iterable"). When the turn
 *     carried tool calls the text stays as-is and the calls are re-serialised.
 *  2. `tool` message content becomes a plain string.
 *
 * Everything else - `role:"tool"` with `tool_call_id`, `assistant.tool_calls`,
 * `image_url` parts - is passed through untouched. Pre-converting to Anthropic
 * `tool_use`/`tool_result` blocks is what breaks the round-trip: the server's
 * converter drops a `tool_result` block and the model calls the tool again.
 *
 * Returns `{ messages, system }`. The system text is returned separately because
 * Perch takes one system turn and PI may send several.
 */
function translateMessages(messages) {
  const out = [];
  const systemParts = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role ?? "").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = textOf(message.content).trim();
      if (text !== "") systemParts.push(text);
      continue;
    }
    if (role === "tool") {
      const id = String(message.tool_call_id ?? message.tool_use_id ?? "");
      const turn = { role: "tool", content: textOf(message.content) };
      if (id !== "") turn.tool_call_id = id;
      out.push(turn);
      continue;
    }
    if (role === "assistant") {
      const text = textOf(message.content);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const calls = [];
      for (const call of toolCalls) {
        const name = String(call?.function?.name ?? call?.name ?? "").trim();
        if (name === "") continue;
        const args = argumentsObjectOf(call?.function?.arguments ?? call?.arguments);
        calls.push({
          id: String(call?.id ?? newCallId()),
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        });
      }
      if (calls.length === 0 && text === "") continue;
      const turn = { role: "assistant", content: text };
      if (calls.length > 0) turn.tool_calls = calls;
      out.push(turn);
      continue;
    }
    // user, or an unknown role treated as user
    const text = textOf(message.content);
    if (text === "" && !Array.isArray(message.content)) continue;
    const turn = { role: "user", content: text };
    // Non-text parts (images) go through as an OpenAI content array, which the
    // server's converter understands without help.
    if (Array.isArray(message.content)) {
      const parts = [];
      for (const part of message.content) {
        if (typeof part === "string") {
          if (part !== "") parts.push({ type: "text", text: part });
          continue;
        }
        if (!part || typeof part !== "object") continue;
        if (part.type === "image_url" || part.type === "input_image") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (typeof url === "string" && url.trim() !== "") parts.push({ type: "image_url", image_url: { url: url.trim() } });
          continue;
        }
        if (part.type === "text" || part.type === "input_text") {
          const value = typeof part.text === "string" ? part.text : "";
          if (value !== "") parts.push({ type: "text", text: value });
        }
      }
      if (parts.some((part) => part.type === "image_url")) turn.content = parts;
    }
    out.push(turn);
  }
  return { messages: out, system: systemParts.join("\n\n") };
}

/** OpenAI tool declarations into Perch's `{ type: "function", function: {...} }`. */
function translateTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = [];
  for (const tool of list) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = String(fn.name ?? tool.name ?? "").trim();
    if (name === "") continue;
    const parameters = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} };
    out.push({
      type: "function",
      function: {
        name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters,
      },
    });
  }
  return out;
}

/**
 * PI's thinking level into Perch's `reasoning` block.
 *
 * Perch's own ladder is off/low/medium/high/xhigh/max plus "ultra", and the
 * model's catalog row decides which rungs exist. A level the row does not list is
 * clamped down to the nearest rung it does, because a request for a rung the model
 * lacks is answered with an error rather than a downgrade.
 */
const PERCH_EFFORT_ORDER = ["off", "low", "medium", "high", "xhigh", "max", "ultra"];

function clampEffort(wanted, allowed) {
  const list = Array.isArray(allowed) ? allowed.filter((level) => PERCH_EFFORT_ORDER.includes(level)) : [];
  if (list.length === 0) return null;
  const needle = String(wanted ?? "").trim().toLowerCase();
  if (needle !== "" && list.includes(needle)) return needle;
  if (needle === "") return null;
  const wantIndex = PERCH_EFFORT_ORDER.indexOf(needle);
  if (wantIndex < 0) return null;
  // Nearest rung at or below the request, then the lowest rung above it.
  let best = null;
  for (const level of list) {
    const index = PERCH_EFFORT_ORDER.indexOf(level);
    if (index <= wantIndex && (best === null || index > PERCH_EFFORT_ORDER.indexOf(best))) best = level;
  }
  if (best !== null) return best;
  let lowest = list[0];
  for (const level of list) {
    if (PERCH_EFFORT_ORDER.indexOf(level) < PERCH_EFFORT_ORDER.indexOf(lowest)) lowest = level;
  }
  return lowest;
}

function reasoningFor(thinkingLevel, allowedLevels) {
  const level = clampEffort(thinkingLevel, allowedLevels);
  if (level === null) return null;
  if (level === "off") return { enableThinking: false };
  return { enableThinking: true, effort: level };
}

/** Build the internal request consumed by cli.js (not an HTTP request). */
function buildModelCallBody(options) {
  const { messages, tools, maxTokens, temperature, system, pin, thinkingLevel, allowedLevels } = options;
  const request = {};
  if (system !== undefined && system !== null && String(system).trim() !== "") request.system = String(system);
  request.messages = messages;
  if (Number.isFinite(maxTokens) && maxTokens > 0) request.maxTokens = Math.floor(maxTokens);
  if (Number.isFinite(temperature)) request.temperature = temperature;
  if (Array.isArray(tools) && tools.length > 0) request.tools = tools;
  const body = { request };
  if (pin) body.manualModelOptionId = pin;
  const reasoning = reasoningFor(thinkingLevel, allowedLevels);
  if (reasoning) body.reasoning = reasoning;
  return body;
}

/** A Perch usage object into OpenAI's `usage` shape. */
function openAIUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.inputTokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.outputTokens ?? usage.completion_tokens ?? 0) || 0;
  const cached = Number(usage.cacheReadInputTokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? 0) || prompt + completion;
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

/** A Perch `toolCalls` array into OpenAI's `tool_calls`. */
function openAIToolCalls(toolCalls) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const out = [];
  for (const call of list) {
    const name = String(call?.name ?? "").trim();
    if (name === "") continue;
    const args = call?.arguments;
    const serialised = typeof args === "string" ? args : JSON.stringify(args ?? {});
    out.push({
      id: String(call?.id ?? newCallId()),
      type: "function",
      function: { name, arguments: serialised },
    });
  }
  return out;
}

/**
 * Map a Perch finishReason onto OpenAI's.
 *
 * Perch answers with Anthropic's vocabulary (`end_turn`, `max_tokens`,
 * `tool_use`) as well as OpenAI's; both are folded onto the OpenAI set PI expects.
 */
function openAIFinishReason(reason, sawToolCalls) {
  const stated = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (stated === "tool_use" || stated === "tool_calls") return "tool_calls";
  if (stated === "max_tokens" || stated === "length") return "length";
  if (stated === "end_turn" || stated === "stop" || stated === "stop_sequence") return "stop";
  if (stated === "content_filter" || stated === "refusal") return "content_filter";
  if (stated !== "") return stated;
  return sawToolCalls ? "tool_calls" : "stop";
}

/**
 * A non-streaming Perch answer into an OpenAI completion object.
 *
 * `model` echoes what the plugin asked for, not what Perch reports, because the
 * reported name is the backend's (`deepseek/deepseek-v4.1-flash`) and PI keys its
 * cost and context bookkeeping on the id it requested. The backend name travels
 * in `x_perch_backend_model` so a caller can still see where it actually ran.
 */
function completionFromAnswer(answer, options) {
  const requestedModel = String(options?.model ?? "perch");
  const toolCalls = openAIToolCalls(answer?.toolCalls);
  const text = typeof answer?.text === "string" ? answer.text : textOf(answer?.content);
  const message = { role: "assistant", content: text === "" ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = openAIUsage(answer?.usage);
  const completion = {
    id: "chatcmpl-" + crypto.randomBytes(12).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: openAIFinishReason(answer?.finishReason, toolCalls.length > 0),
        logprobs: null,
      },
    ],
  };
  if (usage) completion.usage = usage;
  if (typeof answer?.model === "string" && answer.model !== "") completion.x_perch_backend_model = answer.model;
  if (typeof answer?.provider === "string" && answer.provider !== "") completion.x_perch_provider = answer.provider;
  if (Number.isFinite(answer?.durationMs)) completion.x_perch_duration_ms = answer.durationMs;
  if (Number.isFinite(answer?.contextInputTokens)) completion.x_perch_context_tokens = answer.contextInputTokens;
  return completion;
}

module.exports = {
  PERCH_EFFORT_ORDER,
  argumentsObjectOf,
  buildModelCallBody,
  clampEffort,
  completionFromAnswer,
  contentBlockOf,
  contentBlocksOf,
  imageBlock,
  newCallId,
  openAIFinishReason,
  openAIToolCalls,
  openAIUsage,
  reasoningFor,
  textOf,
  translateMessages,
  translateTools,
};
