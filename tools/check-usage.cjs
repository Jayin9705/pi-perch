"use strict";
const {readCliSession}=require("../plugin/lib/auth");
const {createCatalogCache}=require("../plugin/lib/catalog");
const {createUsageCache}=require("../plugin/lib/usage");
const {createModelUsageCache}=require("../plugin/lib/model-usage");
(async()=>{
  const credentials={get:async()=>readCliSession()};
  const catalog=createCatalogCache();await catalog.get(await credentials.get());
  const usage=createUsageCache({credentials});
  const detail=await createModelUsageCache({credentials,usage,catalog}).get();
  if(!detail.ok||!detail.complete)throw new Error(detail.error||"Incomplete account ledger");
  console.log(JSON.stringify({ok:detail.ok,complete:detail.complete,periodStart:detail.periodStart,periodEnd:detail.periodEnd,recordCount:detail.recordCount,expectedRecords:detail.expectedRecords,models:detail.rows.length,totals:detail.totals,top:detail.rows.slice(0,3).map(m=>({label:m.label,calls:m.calls,usagePt:m.usagePt}))},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
