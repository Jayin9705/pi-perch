/**
 * The Perch Bridge panel.
 *
 * A plain webview page: it has no access to `pi`, only to the fixed bridge the host
 * injects as `window.pluginBridge`. Every richer call goes through
 * `pluginBridge.invoke(channel, payload)`, which the host routes to this plugin's
 * `onPanelInvoke`.
 *
 * The panel is read-mostly: it reports the sign-in, the catalog and what was last
 * published, and offers three actions (refresh, test, reload catalog). Nothing here
 * can change which models the plugin declares - that follows the plan's own catalog.
 */

const bridge = window.pluginBridge;

const elements = {
  dot: document.getElementById("state-dot"),
  count: document.getElementById("model-count"),
  rows: document.getElementById("model-rows"),
  refresh: document.getElementById("refresh"),
  test: document.getElementById("test"),
  testCard: document.getElementById("test-card"),
  testClose: document.getElementById("test-close"),
  testOutput: document.getElementById("test-output"),
  footNote: document.getElementById("foot-note"),
  setup: document.getElementById("setup"),
  login: document.getElementById("login"),
  loginCancel: document.getElementById("login-cancel"),
  loginProvider: document.getElementById("login-provider"),
  loginState: document.getElementById("login-state"),
  usageSummary: document.getElementById("usage-summary"),
  usageMeters: document.getElementById("usage-meters"),
  usageExtra: document.getElementById("usage-extra"),
  usageRefresh: document.getElementById("usage-refresh"),
  mappingNote: document.getElementById("mapping-note"),
  mappingAll: document.getElementById("mapping-all"),
  mappingNone: document.getElementById("mapping-none"),
  mappingSave: document.getElementById("mapping-save"),
  mappingMessage: document.getElementById("mapping-message"),
  modelUsageSummary: document.getElementById("model-usage-summary"),
  modelUsageRows: document.getElementById("model-usage-rows"),
  modelUsageRefresh: document.getElementById("model-usage-refresh"),
};

let catalog = { models: [], lockedModels: [] };
let filter = "all";
let busy = false;
let lastStatus = null;
let polling = false;
let usageBusy = false;
let lastUsageAt = 0;
let modelUsageBusy = false;
let lastModelUsageAt = 0;
const mappingDraft = new Map();
let mappingSummary = null;
let mappingSaving = false;
let mappingFeedback = "";

function formatTokenMillions(value) {
  const tokens=Number(value);
  if(!Number.isFinite(tokens)||tokens<0)return "—";
  if(tokens===0)return "0M";
  if(tokens<1000)return "<0.001M";
  return (tokens/1000000).toLocaleString(undefined,{minimumFractionDigits:3,maximumFractionDigits:3})+"M";
}

async function refreshModelUsage(force=false) {
  if(modelUsageBusy)return;
  modelUsageBusy=true;elements.modelUsageRefresh.disabled=true;
  try {
    const result=await call("perch.modelUsage",{force});
    lastModelUsageAt=Date.now();elements.modelUsageRows.replaceChildren();
    if(!result?.ok) {
      elements.modelUsageSummary.textContent=result?.error || "账号用量明细暂不可用";
      const row=el("tr"),cell=el("td","empty","没有可核验的套餐周期数据");cell.colSpan=7;row.append(cell);elements.modelUsageRows.append(row);return;
    }
    elements.modelUsageSummary.textContent=formatTimestamp(Date.parse(result.periodStart))+" → "+formatTimestamp(Date.parse(result.periodEnd))+" · 截至 "+formatTimestamp(Date.parse(result.snapshotAt))+" · "+result.recordCount.toLocaleString()+" 次模型调用"+(!result.complete?" · 数据未取全，以下为已取得部分":"")+(result.stale?" · 上次成功读取的数据":"");
    const values=(row)=>[row.calls,row.promptTokens,row.completionTokens,row.cachedTokens,row.totalTokens,row.usagePt];
    const appendRow=(name,stats,detail)=>{
      const row=el("tr"),cell=el("td",null,name);if(detail)cell.append(el("div","sub",detail));row.append(cell);
      values(stats).forEach((v,i)=>{
        const tokenColumn=i>=1&&i<=4;
        const cell=el("td","num",tokenColumn?formatTokenMillions(v):Number(v||0).toLocaleString(undefined,{maximumFractionDigits:i===5?2:0}));
        if(tokenColumn)cell.title=Number(v||0).toLocaleString()+" Token";
        row.append(cell);
      });
      elements.modelUsageRows.append(row);
    };
    appendRow("合计",result.totals);
    for(const item of result.rows)appendRow(item.label,item,item.modelId?null:item.provider?"其他 / 内部模型 · "+item.provider:"历史模型");
  } finally {modelUsageBusy=false;elements.modelUsageRefresh.disabled=false;}
}

async function refreshUsage(force=false) {
  if (usageBusy) return;
  usageBusy=true; elements.usageRefresh.disabled=true;
  try {
    const usage=await call("perch.usage",{force});
    lastUsageAt=Date.now();
    elements.usageMeters.replaceChildren();
    elements.usageExtra.textContent="";
    if(!usage?.ok){elements.usageSummary.textContent=usage?.error || "额度暂不可用";return;}
    elements.usageSummary.textContent=usage.planName+" · "+(usage.stale?"上次成功读取的数据":"更新于 "+formatTimestamp(usage.fetchedAt))+(usage.periodEnd?" · 本期截止 "+formatTimestamp(Date.parse(usage.periodEnd)):"");
    for(const row of usage.rows || []) {
      const card=el("div","quota-card");
      card.append(el("div","quota-label",(row.lane==="manual"?"手动选模":"公平使用")+" · "+row.window.toUpperCase()));
      card.append(el("strong",null,row.percent===null?"未提供上限":row.percent.toFixed(1)+"% 已用"));
      const progress=el("progress");progress.max=100;progress.setAttribute("aria-label",row.id+" 用量");
      if(row.percent!==null)progress.value=Math.max(0,Math.min(100,row.percent));
      if(row.percent!==null&&row.percent>=80)progress.className="near-limit";
      card.append(progress);
      card.append(el("div","muted",row.percent===null?"以 Perch 返回信息为准":"剩余 "+Math.max(0,100-row.percent).toFixed(1)+"%"));
      card.append(el("div","muted",row.nextFreedAt?"下次释放："+formatTimestamp(Date.parse(row.nextFreedAt)):"暂无额度释放时间"));
      elements.usageMeters.append(card);
    }
    if(!usage.rows?.length)elements.usageMeters.append(el("p","muted","Perch 尚未返回滚动窗口额度数据。"));
    const extra=[];
    if(usage.monthlyManualPt!==null)extra.push("月度手动用量："+usage.monthlyManualPt.toLocaleString()+" pt");
    if(usage.creditBalancePt!==null)extra.push("额外积分："+usage.creditBalancePt.toLocaleString()+" pt");
    if(usage.promo?.leftPt!==null&&usage.promo?.leftPt!==undefined)extra.push("活动额度剩余："+usage.promo.leftPt.toLocaleString()+" pt"+(usage.promo.models?.length?"（"+usage.promo.models.join("、")+"）":""));
    if(usage.stale&&usage.error)extra.push(usage.error);
    elements.usageExtra.textContent=extra.join(" · ");
  } finally {usageBusy=false;elements.usageRefresh.disabled=false;}
}

/** One bridge call, with a readable failure instead of an unhandled rejection. */
async function call(channel, payload) {
  if (!bridge || typeof bridge.invoke !== "function") {
    return { ok: false, error: "the panel bridge is not available" };
  }
  try {
    const result = await bridge.invoke(channel, payload ?? {});
    if (result === undefined || result === null) return { ok: false, error: "the plugin answered nothing" };
    return result;
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 400) };
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setBusy(value) {
  busy = value;
  for (const button of [elements.refresh, elements.test]) {
    button.disabled = value;
  }
  if (!value) elements.test.disabled = !lastStatus?.signedIn || lastStatus?.runtime?.state !== "ready";
}

function setState(level, note) {
  elements.dot.className = "dot" + (level ? " " + level : "");
  elements.dot.title = note ?? "";
}

function formatTimestamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

function formatRelative(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  return hours + "h ago";
}

function formatContext(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000000) return (value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1) + "M";
  if (value >= 1000) return Math.round(value / 1000) + "K";
  return String(value);
}

/** Keep login controls usable without displaying a technical status card. */
function renderStatus(status) {
  lastStatus = status;
  if (!status?.ok) {
    setState("bad", "暂不可用");
    elements.loginState.textContent = status?.error ?? "插件暂未响应，请稍后刷新。";
    elements.count.textContent = "—";
    return;
  }

  const signedIn = status.signedIn === true;
  const started = status.started === true;
  const runtimeReady = status.runtime?.state === "ready";
  const signingIn = ["preparing", "waiting"].includes(status.login?.state);
  elements.setup.hidden = runtimeReady;
  elements.setup.disabled = status.runtime?.state === "installing";
  elements.login.disabled = signingIn;
  elements.login.textContent = signedIn ? "重新登录" : "登录 Perch";
  elements.loginCancel.hidden = !signingIn;
  elements.loginProvider.disabled = signingIn;
  elements.loginState.textContent = status.login?.message || status.runtime?.error || (!signedIn ? status.signInError : status.lastError) || (signedIn&&runtimeReady?"已登录，可在 PI 中选择 Perch 模型。":status.runtime?.phase || "");
  elements.test.disabled = busy || !signedIn || !runtimeReady;
  if (!signedIn) setState("bad", "未登录");
  else if (!started) setState("warn", "服务未启动");
  else if (status.lastError) setState("warn", status.lastError);
  else if (!runtimeReady) setState("warn", status.runtime?.phase || "正在准备组件");
  else setState("ok", "已连接");

  const count = Number(status.modelCount) || 0;
  elements.count.textContent = count > 0 ? String(count) : "—";
}

function updateMappingControls() {
  elements.mappingSave.disabled=mappingSaving||mappingDraft.size===0;
  elements.mappingAll.disabled=elements.mappingNone.disabled=mappingSaving||!catalog.models.length;
  elements.mappingMessage.textContent=mappingSaving?"正在保存…":mappingFeedback || (mappingDraft.size?mappingDraft.size+" 项修改待保存":"");
  const total=catalog.models.length;
  elements.mappingNote.textContent=mappingSummary?.verified
    ? "PI 已映射 "+mappingSummary.registeredCount+" / "+total+" 个可用模型；已选择 "+mappingSummary.selectedCount+" 个。"+(mappingSummary.requiresReload?" 待同步：请在插件管理中关闭后重新启用本插件。":"")
    : "暂未核验 PI 映射："+(mappingSummary?.error||"请稍后刷新");
}
function setMappingChoice(model, enabled) {
  mappingFeedback="";
  if(enabled===(model.mappingEnabled!==false))mappingDraft.delete(model.id);else mappingDraft.set(model.id,enabled);
}
function setAllMappings(enabled) {
  for(const model of catalog.models)setMappingChoice(model,enabled);
  renderModels();
}
async function saveMappings() {
  if(mappingSaving||!mappingDraft.size)return;
  mappingSaving=true;mappingFeedback="";renderModels();
  const changes=[...mappingDraft].map(([id,enabled])=>({id,enabled}));
  try {
    const result=await call("perch.mapping.save",{changes});
    if(!result?.ok){mappingFeedback=result?.error || "映射保存失败";return;}
    mappingDraft.clear();
    mappingFeedback="映射已保存。请在 PI 插件管理中关闭后重新启用本插件，使模型列表更新。";
    await refreshAll();
  } finally {mappingSaving=false;renderModels();}
}

/** One table row. */
function modelRow(model) {
  const row = el("tr", model.locked ? "locked" : null);
  const nameCell = el("td");
  nameCell.append(el("div", "name", model.label ?? model.id));
  const subParts = [model.id];
  if (model.keepsData) subParts.push("keeps prompts 30d");
  nameCell.append(el("div", "sub", subParts.join(" · ")));

  const groupCell = el("td");
  const group = String(model.group ?? "models");
  const tag = el("span", "tag" + (group === "pro" ? " pro" : group === "ultra" ? " ultra" : ""), group);
  groupCell.append(tag);
  if (model.locked) {
    groupCell.append(el("div", "sub", "needs " + (model.requires ?? "a higher plan")));
  }

  const contextCell = el("td", "num", formatContext(model.contextWindow));

  const thinkingCell = el("td");
  const levels = Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [];
  thinkingCell.append(el("div", "sub", levels.length > 0 ? levels.join(" / ") : "—"));
  if (model.defaultThinkingLevel && levels.length > 0) {
    thinkingCell.append(el("div", "sub", "default: " + model.defaultThinkingLevel));
  }

  const pinCell = el("td", "pin");
  if (model.locked) {
    pinCell.append(el("span", "unverified", "套餐未开放"));
  } else if (model.optionId) {
    const enabled=mappingDraft.has(model.id)?mappingDraft.get(model.id):model.mappingEnabled!==false;
    const label=el("label","mapping-toggle");
    const checkbox=el("input");checkbox.type="checkbox";checkbox.checked=enabled;checkbox.disabled=mappingSaving;
    checkbox.setAttribute("aria-label","映射 "+(model.label || model.id)+" 到 PI");
    checkbox.dataset.modelId=model.id;
    const state=mappingDraft.has(model.id)?"待保存":model.piRegistered===null?"未核验":model.piRegistered!==enabled?"待同步":enabled?"已映射":"未映射";
    label.append(checkbox,el("span",null,state));pinCell.append(label);
    checkbox.addEventListener("change",()=>{setMappingChoice(model,checkbox.checked);renderModels();});
    pinCell.title=model.piModelKey || "";
  } else {
    pinCell.append(el("span", "unverified", "—"));
  }

  row.append(nameCell, groupCell, contextCell, thinkingCell, pinCell);
  return row;
}

/** The table, honouring the active filter. */
function renderModels() {
  updateMappingControls();
  const rows = elements.rows;
  rows.replaceChildren();
  const available = Array.isArray(catalog.models) ? catalog.models : [];
  const locked = Array.isArray(catalog.lockedModels) ? catalog.lockedModels : [];
  let list = [];
  if (filter === "locked") list = locked;
  else if (filter === "pro") list = available.filter((model) => model.group === "pro" || model.group === "ultra");
  else list = available;

  if (list.length === 0) {
    const row = el("tr");
    const cell = el("td", "empty", filter === "locked" ? "No locked models on this plan." : "No models. Check the sign-in and refresh.");
    cell.colSpan = 5;
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const model of list) rows.append(modelRow(model));
}

/** Re-read the connection card and the catalog together. */
async function refreshAll(options) {
  setBusy(true);
  try {
    const status = await call("perch.status");
    renderStatus(status);
    const models = await call("perch.models", { force: options?.force === true });
    if (models?.ok) {
      catalog = { models: models.models ?? [], lockedModels: models.lockedModels ?? [] };
      mappingSummary=models.mapping;
      for(const [id,enabled] of mappingDraft) {
        const row=catalog.models.find(model=>model.id===id);
        if(!row || enabled===(row.mappingEnabled!==false))mappingDraft.delete(id);
      }
      renderModels();
      elements.count.textContent = String(catalog.models.length);
      if (models.canPickModel === false) {
        setState("warn", "the plan does not allow model selection; Perch routes automatically");
      }
      const available = catalog.models.length;
      const lockedCount = catalog.lockedModels.length;
      elements.footNote.textContent =
        "Serving " + available + " models on 127.0.0.1" + (lockedCount > 0 ? " · " + lockedCount + " locked by plan" : "");
    } else {
      const row = el("tr");
      const cell = el("td", "empty error-text", models?.error ?? "The model list could not be read.");
      cell.colSpan = 5;
      row.append(cell);
      elements.rows.replaceChildren(row);
      setState("warn", "model list unavailable");
    }
  } finally {
    setBusy(false);
  }
  void refreshUsage(options?.force===true);
  void refreshModelUsage(options?.force===true);
}

/** Run one live call and show what came back. */
async function runTest() {
  setBusy(true);
  elements.testCard.hidden = false;
  elements.testOutput.textContent = "Calling Perch…";
  try {
    const target = catalog.models.find(m=>m.id.startsWith("deepseek"))?.id || catalog.models.find(m=>m.id.startsWith("gpt-"))?.id;
    if(!target)throw new Error("当前列表没有可用于连接测试的 DeepSeek / GPT 模型。");
    const result = await call("perch.test", { model: target });
    elements.testOutput.textContent = JSON.stringify(result, null, 2);
    elements.testOutput.className = result?.ok ? null : "error-text";
    void refreshUsage(true);
  } catch (error) {
    elements.testOutput.textContent = String(error?.message ?? error);
    elements.testOutput.className = "error-text";
  } finally {
    setBusy(false);
  }
}

function bind() {
  elements.mappingAll.addEventListener("click",()=>setAllMappings(true));
  elements.mappingNone.addEventListener("click",()=>setAllMappings(false));
  elements.mappingSave.addEventListener("click",()=>{void saveMappings();});
  elements.usageRefresh.addEventListener("click",()=>{void refreshUsage(true);});
  elements.modelUsageRefresh.addEventListener("click",()=>{void refreshModelUsage(true);});
  elements.setup.addEventListener("click", async () => {await call("perch.setup");await refreshAll();});
  elements.login.addEventListener("click", async () => {await call("perch.login", {provider:elements.loginProvider.value});await refreshAll();});
  elements.loginCancel.addEventListener("click", async () => {await call("perch.login.cancel");await refreshAll();});
  elements.refresh.addEventListener("click", () => {
    void refreshAll({ force: true });
  });
  elements.test.addEventListener("click", () => {
    void runTest();
  });
  elements.testClose.addEventListener("click", () => {
    elements.testCard.hidden = true;
  });
  for (const chip of document.querySelectorAll(".chip[data-filter]")) {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter ?? "all";
      for (const other of document.querySelectorAll(".chip[data-filter]")) {
        other.setAttribute("aria-pressed", other === chip ? "true" : "false");
      }
      renderModels();
    });
  }
  // The host pushes a settings document when the user edits this plugin; the
  // panel's own view is stale from that moment, so it re-reads.
  try {
    if (bridge && typeof bridge.on === "function") {
      bridge.on("plugin:settingsChanged", () => {
        void refreshAll();
      });
    }
  } catch {
    /* the event channel is optional */
  }
}

bind();
void refreshAll();
setInterval(async () => {
  if (busy || polling) return;
  polling = true;
  try {
    const previous = lastStatus;
    const status = await call("perch.status");
    renderStatus(status);
    if (status.ok && (status.signedIn !== previous?.signedIn || status.modelCount !== previous?.modelCount || status.runtime?.state !== previous?.runtime?.state || status.login?.state !== previous?.login?.state)) await refreshAll();
    else if(mappingSummary?.requiresReload && !mappingSaving && !mappingDraft.size)await refreshAll();
    if(Date.now()-lastUsageAt>60000)void refreshUsage();
    if(Date.now()-lastModelUsageAt>300000)void refreshModelUsage();
  } finally {polling = false;}
}, 3000);
