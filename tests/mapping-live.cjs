"use strict";
// PI metadata/UI test only. Never sends a prompt or calls a model.
const assert=require("node:assert/strict");
const {evaluate}=require("../tools/pi-eval.cjs");
const {invoke}=require("../tools/pi-invoke.cjs");
const pluginId="local.pi-perch", providerId="plugin:local.pi-perch:perch", modelId="gpt-6.1-terra";
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function panel(expression) {
  return evaluate('(()=>{const e=process.getBuiltinModule("module").createRequire(process.execPath)("electron");const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("local.pi-perch/renderer"));if(!w)throw Error("panel closed");return w.webContents.executeJavaScript('+JSON.stringify(expression)+');})()');
}
async function reopen() {await invoke("pluginOpenPanel",pluginId);}
async function waitMapping(enabled) {
  for(let i=0;i<30;i++) {
    const result=await invoke("providersList");
    const models=result.providers.find(p=>p.id===providerId)?.models || [];
    if(models.some(m=>m.id===modelId)===enabled)return models.length;
    await wait(500);
  }
  throw new Error("PI did not synchronize the selected mapping");
}
(async()=>{
  await reopen();
  const before=await panel('window.pluginBridge.invoke("perch.models",{})');
  const model=before.models.find(m=>m.id===modelId);
  assert.ok(model,"GPT test mapping exists");
  const original=model.mappingEnabled;
  try {
    const code=`(()=>{const box=document.querySelector('input[data-model-id="${modelId}"]');if(!box)throw Error("mapping checkbox missing");box.click();const changed=box.checked;document.getElementById("mapping-save").click();return changed;})()`;
    assert.equal(await panel(code),!original);
    await wait(2500);
    await invoke("pluginEnable",pluginId);
    console.log("PI model count after toggle",await waitMapping(!original));
    // Persisted choice must survive a host reload, not only the current process.
    await invoke("pluginReload",pluginId);
    console.log("PI model count after reload",await waitMapping(!original));
    const list=await fetch("http://127.0.0.1:41891/v1/models").then(r=>r.json());
    assert.equal(list.data.some(m=>m.id===modelId),!original);
    await reopen();
    const after=await panel('window.pluginBridge.invoke("perch.models",{})');
    assert.equal(after.models.find(m=>m.id===modelId).mappingEnabled,!original);
    assert.equal(after.mapping.requiresReload,false);
    console.log("UI and persisted mapping verified without model calls");
  } finally {
    await reopen();
    const saved=await panel('window.pluginBridge.invoke("perch.mapping.save",'+JSON.stringify({changes:[{id:modelId,enabled:original}]})+')');
    assert.equal(saved.ok,true);
    await wait(2500);
    await invoke("pluginEnable",pluginId);
    console.log("Restored original PI model count",await waitMapping(original));
    await reopen();
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
