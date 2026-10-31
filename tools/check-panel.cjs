"use strict";
const {evaluate}=require("./pi-eval.cjs");
(async()=>{
  const js=`(async()=>{
    const status=await window.pluginBridge.invoke("perch.status",{});
    const models=await window.pluginBridge.invoke("perch.models",{});
    const usage=await window.pluginBridge.invoke("perch.usage",{});
    const detail=await window.pluginBridge.invoke("perch.modelUsage",{});
    return {version:status.version,started:status.started,runtime:status.runtime,login:status.login?.state,mapping:models.mapping,
      quotas:usage.rows?.map(r=>({id:r.id,percent:r.percent,nextFreedAt:r.nextFreedAt})),
      period:{ok:detail.ok,complete:detail.complete,start:detail.periodStart,end:detail.periodEnd,records:detail.recordCount,models:detail.rows?.length,error:detail.error},
      ui:{mapping:document.getElementById("mapping-note")?.textContent,quotaCards:document.querySelectorAll(".quota-card").length,usageRows:document.getElementById("model-usage-rows")?.children.length,summary:document.getElementById("model-usage-summary")?.textContent}};
  })()`;
  const expression='(()=>{const e=process.getBuiltinModule("module").createRequire(process.execPath)("electron");const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("local.pi-perch/renderer"));if(!w)throw Error("Perch panel not open");return w.webContents.executeJavaScript('+JSON.stringify(js)+');})()';
  console.log(JSON.stringify(await evaluate(expression),null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
