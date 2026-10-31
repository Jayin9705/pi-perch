"use strict";

// The official ACP entry point owns authentication and model execution. Never
// call the private model-call endpoint or imitate another client's HTTP headers.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { PerchError } = require("./upstream");
const { createManagedRuntime } = require("./runtime");

function bridgePrompt(body) {
  const request = body.request || {};
  const tools = request.tools || [];
  const images = [];
  const messages = (request.messages || []).map(m => {
    if (!Array.isArray(m.content)) return m;
    return {...m, content:m.content.map(part => {
      if (part.type !== "image_url") return part;
      const url = part.image_url?.url || "";
      const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(url);
      if (!match) throw new PerchError("CLI 桥接目前只接收内嵌图片，请在 PI 中直接附加图片文件。", {code:"unsupported_image_url",status:400});
      images.push({type:"image",mimeType:match[1],data:match[2]});
      return {type:"text",text:`[Attached image ${images.length}]`};
    })};
  });
  const instructions = [
    "You are assisting a PI-Desktop conversation through the official Perch CLI ACP integration.",
    "Continue the conversation provided below. Its system instructions describe the user's PI workspace and task.",
    "PI manages its own tools and files. Do not run Perch tools or inspect the bridge's working directory.",
    "Treat tool results already present in the conversation as the results PI has actually returned; do not repeat completed calls.",
  ];
  if (tools.length) instructions.push(
    'Reply with exactly one JSON object, without markdown fences or surrounding commentary: {"content":"your response text", "tool_calls":[]}.',
    'When an action or information from a listed PI tool is needed, put a request in tool_calls: {"name":"exact listed name", "arguments":{...}}. PI will execute it and return the result next turn.',
    "Use only the supplied tool names and their parameter schemas. Never invent a tool result. If a tool is needed, emit its call now instead of describing a plan or asking the user to execute it.",
    "When the task is complete, tool_calls must be empty and content is the final answer. Preserve the user's language. JSON string content may contain Markdown.",
    `Tool selection: ${JSON.stringify(request.toolChoice ?? "auto")}.`,
  );
  else instructions.push("Return only the assistant's answer to the last user message, without quoting the supplied conversation or adding a bridge preamble.");
  return [{type:"text",text:instructions.join("\n") + "\n\nPI conversation (JSON):\n" + JSON.stringify({system:request.system || "",messages,tools})}, ...images];
}

function decodeToolReply(text, tools, toolChoice) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  let body;
  try { body = JSON.parse(trimmed); }
  catch { throw new PerchError("Perch 未返回有效的 PI 工具协议，请重试或切换模型。", {code:"cli_tool_protocol",status:422}); }
  if (!body || typeof body.content !== "string" || !Array.isArray(body.tool_calls)) {
    throw new PerchError("Perch 返回的工具消息格式不完整。", {code:"cli_tool_protocol",status:422});
  }
  const names = new Set(tools.map(t => t.function?.name || t.name));
  const calls = body.tool_calls.map(call => {
    if (!names.has(call.name) || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new PerchError("Perch 请求了未知工具或无效参数，PI 未执行该操作。", {code:"cli_tool_protocol",status:422});
    }
    return {id:"call_" + crypto.randomBytes(12).toString("hex"),name:call.name,arguments:call.arguments};
  });
  const required = typeof toolChoice === "object" ? toolChoice?.function?.name : null;
  if ((toolChoice === "required" && !calls.length) || (toolChoice === "none" && calls.length) ||
      (required && (!calls.length || calls.some(c => c.name !== required)))) {
    throw new PerchError("Perch 未遵守本次工具选择要求。", {code:"cli_tool_protocol",status:422});
  }
  return {text:body.content,toolCalls:calls};
}

function cliFailure(text) {
  // ACP 2.4.120 emits some CLI failures as complete agent text, not RPC errors.
  const value=text.trim();
  if(/^The model is busy right now\. (?:Wait a moment|Try again)/i.test(value))return new PerchError(value,{code:"model_busy",status:429});
  if(/^Your plan includes Perch-hosted models .*Direct API access is not included\./s.test(value))return new PerchError(value,{code:"surface_required",status:403});
  return null;
}

function startAcp(cli, dir, onUpdate) {
  const child = spawn(cli.node, ["--max-old-space-size=2048", cli.entry, "acp"], {
    cwd:dir, windowsHide:true, stdio:["pipe","pipe","pipe"],
    env:{...process.env,ELECTRON_RUN_AS_NODE:"1",PERCH_CLI_SETTINGS_DIR:dir,PERCH_CLI_HEAP_REEXEC:"1",NO_COLOR:"1"},
  });
  let seq = 0, buffer = "", stderr = "", closed = false;
  const decoder = new StringDecoder("utf8");
  const pending = new Map();
  function fail(error) { for (const p of pending.values()) p.reject(error); pending.clear(); }
  const exited = new Promise(resolve => child.once("close", () => {closed = true; resolve();}));
  child.once("error", e => fail(new PerchError("Perch CLI 启动失败: " + e.message, {code:"cli_start_failed",status:503})));
  child.once("close", code => fail(new PerchError("Perch CLI 已退出 (" + code + "). " + stderr.slice(-300), {code:"cli_exited",status:502})));
  child.stdin.on("error", e => fail(new PerchError(e.message, {code:"cli_pipe",status:502})));
  child.stderr.on("data", b => { stderr = (stderr + b.toString()).slice(-2000); });
  function send(m) { if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({jsonrpc:"2.0",...m}) + "\n"); }
  child.stdout.on("data", b => {
    buffer += decoder.write(b);
    if (buffer.length > 32 * 1024 * 1024) { fail(new PerchError("ACP 消息过大", {code:"cli_protocol",status:502})); child.kill(); return; }
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0,i); buffer = buffer.slice(i+1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { fail(new PerchError("ACP 输出不是 JSON", {code:"cli_protocol",status:502})); child.kill(); return; }
      if (pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new PerchError(m.error.message || "Perch CLI 拒绝请求", {code:"cli_refused",status:400})) : p.resolve(m.result);
      } else if (m.id !== undefined) {
        if (m.method === "session/request_permission") send({id:m.id,result:{outcome:{outcome:"cancelled"}}});
        else send({id:m.id,error:{code:-32601,message:"PI executes tools in its own host; this ACP client does not provide this operation."}});
      } else if (m.method === "session/update") onUpdate?.(m.params?.update);
    }
  });
  return {
    rpc(method, params) {
      if (closed) return Promise.reject(new PerchError("Perch CLI 已退出", {code:"cli_exited",status:502}));
      return new Promise((resolve,reject) => { const id = ++seq; pending.set(id,{resolve,reject}); send({id,method,params}); });
    },
    cancel(sessionId) { if (sessionId) send({method:"session/cancel",params:{sessionId}}); child.kill(); },
    async close() {
      if (!closed) child.kill();
      await exited;
    },
  };
}

function createCliClient(options = {}) {
  const managed = createManagedRuntime(options);
  const root = path.resolve(options.dataDir, "acp");
  fs.mkdirSync(root, {recursive:true});
  let queue = Promise.resolve();
  const running = new Set();
  let stopped = false;
  const stats = {transport:"official-cli-acp",calls:0,lastModel:null,lastError:null};
  function serialized(job) {
    const result = queue.then(() => { if (stopped) throw new PerchError("插件已停止", {code:"aborted",status:499}); return job(); });
    queue = result.catch(() => {});
    return result;
  }
  async function execute(body, settings = {}, emit) {
    const cli = await managed.ensure();
    if (settings.signal?.aborted) throw new PerchError("请求已取消", {code:"aborted",status:499});
    const dir = fs.mkdtempSync(path.join(root, "request-"));
    const effort = body?.reasoning?.enableThinking === false ? "off" : body?.reasoning?.effort || "low";
    fs.writeFileSync(path.join(dir, "cli-settings.json"), JSON.stringify({
      version:1, chatMode:"agents", permissionMode:"default", cliLocalTools:false,
      roostChoice:"pro", manualModelOptionId:body?.manualModelOptionId || null,
      effort:{level:effort,orchestration:false},
    }));
    const startedAt = Date.now();
    let text = "", sessionId = null, timeout = false;
    const hasTools = (body?.request?.tools?.length || 0) > 0;
    const acp = startAcp(cli, dir, update => {
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        text += update.content.text || "";
        if (!hasTools) emit?.({type:"answer_delta",text:update.content.text || ""});
      }
      if (update?.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") emit?.({type:"reasoning_delta",text:update.content.text || ""});
    });
    running.add(acp);
    const abort = () => acp.cancel(sessionId);
    settings.signal?.addEventListener("abort", abort, {once:true});
    const timer = setTimeout(() => { timeout = true; abort(); }, settings.timeoutMs || 180000);
    try {
      await acp.rpc("initialize", {protocolVersion:1,clientInfo:{name:"pi-perch",version:"0.2.0"},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
      sessionId = (await acp.rpc("session/new", {cwd:dir,mcpServers:[]})).sessionId;
      if (!body) return {ok:true}; // Let the official CLI refresh its own session.
      const result = await acp.rpc("session/prompt", {sessionId,prompt:bridgePrompt(body)});
      if (result?.stopReason === "cancelled") throw new PerchError("Perch 已取消本次请求", {code:"aborted",status:499});
      if (!text.trim()) throw new PerchError("Perch CLI 未返回回复", {code:"cli_empty",status:502});
      const failure=cliFailure(text); if(failure)throw failure;
      const parsed = hasTools ? decodeToolReply(text,body.request.tools,body.request.toolChoice) : {text,toolCalls:[]};
      const answer = {ok:true,...parsed,provider:"perch-cli-acp",finishReason:parsed.toolCalls.length ? "tool_calls" : result?.stopReason || "stop",durationMs:Date.now()-startedAt};
      stats.calls++; stats.lastModel = body.manualModelOptionId; stats.lastError = null;
      emit?.({type:"done",...answer});
      return answer;
    } catch (error) {
      if (timeout) error = new PerchError("Perch CLI 响应超时", {code:"cli_timeout",status:504});
      else if (settings.signal?.aborted) error = new PerchError("请求已取消", {code:"aborted",status:499});
      stats.lastError = error.message;
      throw error;
    } finally {
      clearTimeout(timer); settings.signal?.removeEventListener("abort",abort);
      await acp.close(); running.delete(acp);
      // Only remove the one generated job directory under this plugin's ACP root.
      const target = path.resolve(dir);
      if (path.dirname(target) === root && path.basename(target).startsWith("request-")) fs.rmSync(target,{recursive:true,force:true});
    }
  }
  return {
    prepare() { return managed.ensure(); },
    runtimeStatus() { return managed.status(); },
    managed,
    call(body, settings) { return serialized(() => execute(body,settings)); },
    refreshSession() { return serialized(() => execute(null,{timeoutMs:30000})); },
    async stream(body, settings = {}) {
      const abort = new AbortController();
      const signal = settings.signal ? AbortSignal.any([settings.signal,abort.signal]) : abort.signal;
      let controller, ended = false;
      const stream = new ReadableStream({start(c) {controller=c;},cancel() {ended=true;abort.abort();}});
      const emit = event => {if (!ended) controller.enqueue(Buffer.from("data: " + JSON.stringify(event) + "\n\n"));};
      serialized(() => execute(body,{...settings,signal},emit))
        .catch(error => emit({type:"error",message:error.message,code:error.code}))
        .finally(() => {if (!ended) {ended=true;controller.close();}});
      return {res:{body:stream}};
    },
    diagnostics() { return {...stats, runtime:managed.status()}; },
    async close() {stopped=true; managed.stop(); for (const acp of running) acp.cancel(); await queue;},
  };
}

module.exports = {bridgePrompt,decodeToolReply,createCliClient,startAcp,cliFailure};
