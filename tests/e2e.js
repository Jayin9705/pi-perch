"use strict";

/**
 * End-to-end check: load the plugin, then call its loopback endpoint exactly the way
 * PI's OpenAI adapter would, and print what came back.
 *
 *   node tests/e2e.js            full run
 *   node tests/e2e.js --quick    one model, no tool call
 */

const path = require("node:path");
const { createHarness, loadPlugin } = require("./harness");

const PLUGIN_ROOT = path.join(__dirname, "..", "plugin");
const quick = process.argv.includes("--quick");

function line(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log("  " + label.padEnd(16) + (text === undefined ? "" : text));
}

function section(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

/** Read an SSE body into a list of parsed events. */
async function readSse(response) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const events = [];
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        events.push({ type: "DONE" });
        continue;
      }
      try {
        events.push(JSON.parse(payload));
      } catch {
        events.push({ type: "UNPARSEABLE", raw: payload.slice(0, 120) });
      }
    }
  }
  return events;
}

(async () => {
  const harness = createHarness({ settings: { enabled: true, preferredPort: 41993, refreshSeconds: 600 } });
  const { plugin, restore } = loadPlugin(harness, PLUGIN_ROOT);
  let failures = 0;

  try {
    section("LOAD");
    await plugin.onLoad();
    const status = await plugin.onPanelInvoke("perch.status", {});
    line("started", status.started);
    line("signedIn", status.signedIn);
    line("account", status.email);
    line("baseUrl", status.baseUrl);
    line("models", status.modelCount);
    line("locked", status.lockedCount);
    if (!status.ok || !status.started) {
      console.log("  FAIL: the plugin did not start");
      failures += 1;
    }
    const base = status.baseUrl;
    if (!base) throw new Error("no base URL; cannot continue");

    section("GET /v1/models");
    const listRes = await fetch(base + "/v1/models");
    const list = await listRes.json();
    line("status", listRes.status);
    line("count", list.data?.length);
    line("first", list.data?.[0]?.id);
    if (listRes.status !== 200 || !Array.isArray(list.data) || list.data.length === 0) {
      console.log("  FAIL: the model list is empty");
      failures += 1;
    }

    section("GET /health");
    const healthRes = await fetch(base + "/health");
    line("status", healthRes.status);
    line("body", await healthRes.json());

    const modelId = list.data?.find((model)=>model.id.startsWith("deepseek"))?.id;
    if(!modelId)throw new Error("No DeepSeek model available for the bounded live test");
    const secondModel = list.data?.find((model) => model.id === "gpt-6.1-terra")?.id ?? modelId;

    section("POST /v1/chat/completions (non-stream) - " + modelId);
    const plainRes = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: "You are terse. Answer in as few words as possible." },
          { role: "user", content: "Reply with exactly: PI_PERCH_OK" },
        ],
        max_tokens: 64,
        stream: false,
      }),
    });
    const plainText = await plainRes.text();
    line("status", plainRes.status);
    let plain = null;
    try {
      plain = JSON.parse(plainText);
    } catch {
      plain = null;
    }
    if (!plain) {
      line("body", plainText.slice(0, 400));
      console.log("  FAIL: the non-stream answer is not JSON");
      failures += 1;
    } else {
      const choice = plain.choices?.[0];
      line("content", choice?.message?.content);
      line("finish", choice?.finish_reason);
      line("backend", plain.x_perch_backend_model);
      line("usage", plain.usage);
      if (typeof choice?.message?.content !== "string" || choice.message.content.trim() === "") {
        console.log("  FAIL: the answer carried no text");
        failures += 1;
      }
      if (choice?.finish_reason !== "stop") {
        console.log("  WARN: finish_reason is " + choice?.finish_reason);
      }
    }

    section("POST /v1/chat/completions (stream) - " + secondModel);
    const streamRes = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: secondModel,
        messages: [{ role: "user", content: "Count from 1 to 5, comma separated." }],
        max_tokens: 128,
        stream: true,
      }),
    });
    line("status", streamRes.status);
    line("content-type", streamRes.headers.get("content-type"));
    const events = await readSse(streamRes);
    const textDeltas = events.filter((event) => event.choices?.[0]?.delta?.content).map((event) => event.choices[0].delta.content);
    const finals = events.filter((event) => event.choices?.[0]?.finish_reason);
    const sawDone = events.some((event) => event.type === "DONE");
    line("events", events.length);
    line("text deltas", textDeltas.length);
    line("joined", textDeltas.join("").slice(0, 120));
    line("finish", finals[0]?.choices?.[0]?.finish_reason);
    line("[DONE]", sawDone);
    if (textDeltas.length === 0) {
      console.log("  FAIL: the stream carried no text deltas");
      failures += 1;
    }
    if (!sawDone) {
      console.log("  FAIL: the stream never sent [DONE]");
      failures += 1;
    }

    if (!quick) {
      section("POST /v1/chat/completions (tool call) - " + modelId);
      const toolRes = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the current weather for a city",
                parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              },
            },
          ],
          max_tokens: 256,
          stream: false,
        }),
      });
      const toolBody = await toolRes.json();
      const call = toolBody.choices?.[0]?.message?.tool_calls?.[0];
      line("status", toolRes.status);
      line("finish", toolBody.choices?.[0]?.finish_reason);
      line("tool", call?.function?.name);
      line("args", call?.function?.arguments);
      if (!call) {
        console.log("  FAIL: no tool call came back");
        failures += 1;
      } else {
        if (call.function?.name !== "get_weather") {
          console.log("  FAIL: the tool name is " + call.function?.name);
          failures += 1;
        }
        let args = null;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = null;
        }
        if (!args || args.city !== "Paris") {
          console.log("  FAIL: the tool arguments are not { city: 'Paris' }: " + call.function.arguments);
          failures += 1;
        }
      }

      section("POST /v1/chat/completions (tool round-trip)");
      const roundRes = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_round_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
            { role: "tool", tool_call_id: "call_round_1", content: "18C and sunny" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the current weather for a city",
                parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              },
            },
          ],
          max_tokens: 128,
          stream: false,
        }),
      });
      const roundBody = await roundRes.json();
      line("status", roundRes.status);
      line("content", roundBody.choices?.[0]?.message?.content);
      line("finish", roundBody.choices?.[0]?.finish_reason);
      if (roundRes.status === 200 && roundBody.choices?.[0]?.message?.content) {
        line("verdict", "tool_result accepted");
      } else {
        console.log("  FAIL: the tool round-trip answered " + roundRes.status);
        failures += 1;
      }

      section("POST /v1/chat/completions (unknown model)");
      const badRes = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }] }),
      });
      line("status", badRes.status);
      const badBody = await badRes.json();
      line("code", badBody.error?.code);
      line("message", String(badBody.error?.message ?? "").slice(0, 120));
      if (badRes.status !== 404) {
        console.log("  FAIL: an unknown model should answer 404, got " + badRes.status);
        failures += 1;
      }

      section("POST /v1/chat/completions with a cross-origin request");
      const originRes = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }] }),
      });
      line("status", originRes.status);
      if (originRes.status !== 403) {
        console.log("  FAIL: a cross-origin request should be refused");
        failures += 1;
      }
    }

    section("DECLARATION");
    const diagnostics = await plugin.onPanelInvoke("perch.diagnostics", {});
    line("declared providers", diagnostics.declared);
    line("dataDir", diagnostics.dataDir);
    if (!Array.isArray(diagnostics.declared) || diagnostics.declared.length === 0) {
      console.log("  FAIL: no provider was declared into the manifest");
      failures += 1;
    } else {
      const provider = diagnostics.declared[0];
      if (provider.baseUrl !== base + "/v1") {
        console.log("  FAIL: the declared baseUrl is " + provider.baseUrl + ", expected " + base + "/v1");
        failures += 1;
      }
      if (provider.models < 20) {
        console.log("  WARN: only " + provider.models + " models declared");
      }
    }

    section("RESULT");
    if (failures === 0) {
      console.log("  All checks passed.");
    } else {
      console.log("  " + failures + " check(s) failed.");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("\nFATAL: " + (error?.stack ?? error));
    process.exitCode = 1;
  } finally {
    try {
      await plugin.onUnload();
    } catch (error) {
      console.error("unload failed: " + error?.message);
    }
    restore();
    harness.cleanup();
    // The refresh timer is unref'd, but the server may still be closing.
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  }
})();
