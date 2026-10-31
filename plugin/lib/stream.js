"use strict";

/**
 * Re-frame Perch's SSE into OpenAI's SSE.
 *
 * Perch streams a small set of named events:
 *
 *   data: {"type":"reasoning_delta","text":"..."}
 *   data: {"type":"answer_delta","text":"..."}
 *   data: {"type":"tool_call_delta","toolCalls":[...]}
 *   data: {"type":"tool_use_end","toolCalls":[...]}
 *   data: {"type":"done", ok, text, content, toolCalls, usage, model, ...}
 *   data: {"type":"error","message":"..."}
 *
 * and it opens each stream with a `: keepalive` comment line. PI's OpenAI adapter
 * expects `chat.completion.chunk` objects with `choices[0].delta`, ending in a
 * `finish_reason` and a literal `[DONE]`.
 *
 * Two details are load-bearing:
 *  - A tool call may arrive in pieces. Perch sends the whole array each time
 *    (`tool_call_delta`), so each event is diffed against what was already sent
 *    and only the new prefix is emitted. Emitting the whole array again would make
 *    the client append duplicate argument text.
 *  - `done` carries the authoritative text and tool calls. When a stream carried
 *    deltas the client already has them; when it carried none (a model that answers
 *    in one shot) the text has to be synthesised here or the answer is lost.
 */

const crypto = require("node:crypto");

/** One `data: {...}` line's JSON, or null when the line is a comment or junk. */
function parseEventLine(line) {
  const trimmed = String(line ?? "").trim();
  if (trimmed === "" || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Split an SSE byte stream into complete lines.
 *
 * Chunk boundaries fall anywhere, including mid-line and mid-multibyte-character,
 * so the decoder is fed with `{ stream: true }` and only complete lines are handed
 * on. A trailing partial line is held until the next chunk or the end of the stream.
 */
function createLineReader() {
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    push(chunk) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      return lines;
    },
    flush() {
      buffered += decoder.decode();
      const rest = buffered;
      buffered = "";
      return rest === "" ? [] : rest.split("\n");
    },
  };
}

/**
 * Serialise one OpenAI chunk.
 *
 * Every field PI's adapter reads is present: `id`, `object`, `created`, `model`,
 * `choices[0].delta`, and `finish_reason`. Usage rides on the final chunk under
 * `stream_options.include_usage` conventions, which the adapter asks for.
 */
function chunkBody(options) {
  const { id, created, model, delta, finishReason, usage } = options;
  const choice = { index: 0, delta: delta ?? {}, finish_reason: finishReason ?? null, logprobs: null };
  const body = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [choice],
  };
  if (usage) body.usage = usage;
  return "data: " + JSON.stringify(body) + "\n\n";
}

/**
 * Turn a Perch SSE body into OpenAI SSE text.
 *
 * Returns an object with `push(chunk)` returning the text to send and `end()`
 * returning whatever is left, so the HTTP layer stays a plain pipe. A malformed or
 * failing event ends the translation with an `error` chunk rather than a silent
 * stop, because a truncated stream with a clean `finish_reason` reads to the user
 * as a complete answer that just happened to be short.
 */
function createStreamTranslator(options) {
  const model = String(options?.model ?? "perch");
  const includeUsage = options?.includeUsage !== false;
  const id = "chatcmpl-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const reader = createLineReader();
  let emittedToolCalls = 0;
  let sawAnswer = false;
  let sawReasoning = false;
  let finished = false;
  let pendingUsage = null;
  let backendModel = null;
  let backendProvider = null;
  let durationMs = null;
  let contextTokens = null;

  function toolCallChunk(calls) {
    const out = [];
    for (let index = emittedToolCalls; index < calls.length; index += 1) {
      const call = calls[index];
      const name = String(call?.name ?? "").trim();
      if (name === "") continue;
      const args = call?.arguments;
      out.push({
        index,
        id: String(call?.id ?? "call_" + crypto.randomBytes(12).toString("hex")),
        type: "function",
        function: {
          name,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      });
    }
    if (out.length > 0) emittedToolCalls = calls.length;
    return out;
  }

  function handleEvent(event) {
    if (finished) return "";
    if (!event || typeof event !== "object") return "";
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "answer_delta" && typeof event.text === "string") {
      if (event.text === "") return "";
      sawAnswer = true;
      return chunkBody({ id, created, model, delta: { content: event.text } });
    }
    if (type === "reasoning_delta" && typeof event.text === "string") {
      if (event.text === "") return "";
      sawReasoning = true;
      // PI reads `reasoning_content` for the collapsible thinking pane; the
      // OpenAI field name keeps it out of the answer text.
      return chunkBody({ id, created, model, delta: { reasoning_content: event.text } });
    }
    if ((type === "tool_call_delta" || type === "tool_use_end") && Array.isArray(event.toolCalls)) {
      const calls = toolCallChunk(event.toolCalls);
      if (calls.length === 0) return "";
      return chunkBody({ id, created, model, delta: { tool_calls: calls } });
    }
    if (type === "stream_restart") {
      // Perch resends from the top after a mid-call failover. The client cannot
      // rewind, so the restart is announced and the already-sent text is not
      // repeated; a fresh prefix would duplicate the answer.
      emittedToolCalls = 0;
      return "";
    }
    if (type === "model_call_failed" || type === "retrying") {
      // Progress notices from Perch's own retry loop. They carry no content and
      // are deliberately not forwarded: PI shows its own retry state.
      return "";
    }
    if (type === "error") {
      const message = typeof event.message === "string" ? event.message : "the model call failed";
      finished = true;
      return "data: " + JSON.stringify({ error: { message, type: "perch_stream_error", code: event.code || "perch_stream_error" } }) + "\n\ndata: [DONE]\n\n";
    }
    if (type === "done") {
      finished = true;
      const text = typeof event.text === "string" ? event.text : "";
      const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
      if (typeof event.model === "string" && event.model !== "") backendModel = event.model;
      if (typeof event.provider === "string" && event.provider !== "") backendProvider = event.provider;
      if (Number.isFinite(event.durationMs)) durationMs = event.durationMs;
      if (Number.isFinite(event.contextInputTokens)) contextTokens = event.contextInputTokens;
      const usage = openAIUsageOf(event.usage);
      let out = "";
      // A stream that carried no answer deltas still has to deliver its text.
      if (!sawAnswer && text !== "") {
        out += chunkBody({ id, created, model, delta: { content: text } });
      }
      if (calls.length > emittedToolCalls) {
        const tail = toolCallChunk(calls);
        if (tail.length > 0) out += chunkBody({ id, created, model, delta: { tool_calls: tail } });
      }
      const finishReason = openAIFinishReasonOf(event.finishReason, calls.length > 0);
      const finalChoice = { index: 0, delta: {}, finish_reason: finishReason, logprobs: null };
      const finalBody = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [finalChoice],
      };
      if (backendModel) finalBody.x_perch_backend_model = backendModel;
      if (backendProvider) finalBody.x_perch_provider = backendProvider;
      if (Number.isFinite(durationMs)) finalBody.x_perch_duration_ms = durationMs;
      if (Number.isFinite(contextTokens)) finalBody.x_perch_context_tokens = contextTokens;
      if (includeUsage && usage) finalBody.usage = usage;
      out += "data: " + JSON.stringify(finalBody) + "\n\n";
      out += "data: [DONE]\n\n";
      return out;
    }
    if (type === "continuation_seam" || type === "tool_progress") return "";
    return "";
  }

  return {
    /** Feed one chunk; returns the OpenAI SSE text to write. */
    push(chunk) {
      let out = "";
      for (const line of reader.push(chunk)) {
        const event = parseEventLine(line);
        if (event) out += handleEvent(event);
      }
      return out;
    },
    /** Flush at end of stream; synthesises a terminator when the stream just stopped. */
    end() {
      let out = "";
      for (const line of reader.flush()) {
        const event = parseEventLine(line);
        if (event) out += handleEvent(event);
      }
      if (finished) return out;
      // A stream that ended without a `done` event: close it honestly so the
      // client does not wait forever on a body that will never finish.
      finished = true;
      return out + "data: " + JSON.stringify({error:{message:"Perch stream ended before completion",type:"perch_stream_error",code:"incomplete_stream"}}) + "\n\ndata: [DONE]\n\n";
    },
    /** Everything Perch reported about the answer, for the non-stream path. */
    summary() {
      return { id, created, model, backendModel, backendProvider, durationMs, contextTokens, sawAnswer, sawReasoning, finished };
    },
    setUsage(usage) {
      pendingUsage = usage ?? null;
    },
  };
}

/** The usage helper is shared with the adapter; kept local to avoid a cycle. */
function openAIUsageOf(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.inputTokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.outputTokens ?? usage.completion_tokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? 0) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function openAIFinishReasonOf(reason, sawToolCalls) {
  const stated = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (stated === "tool_use" || stated === "tool_calls") return "tool_calls";
  if (stated === "max_tokens" || stated === "length") return "length";
  if (stated === "end_turn" || stated === "stop" || stated === "stop_sequence") return "stop";
  if (stated === "content_filter" || stated === "refusal") return "content_filter";
  if (stated !== "") return stated;
  return sawToolCalls ? "tool_calls" : "stop";
}

module.exports = {
  createLineReader,
  createStreamTranslator,
  openAIFinishReasonOf,
  openAIUsageOf,
  parseEventLine,
};
