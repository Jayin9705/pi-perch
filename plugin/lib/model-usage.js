"use strict";
const {PIN_TABLE}=require("./catalog");
const numeric = value => value!==null && value!=="" && Number.isFinite(Number(value)) ? Number(value) : 0;
function aggregateModelUsage(records, catalog, start, end) {
  const labels=new Map((catalog?.allModels || catalog?.models || []).map(row=>[row.pin?.optionId,{id:row.id,label:row.label || row.name || row.id}]));
  for(const [id,pin] of Object.entries(PIN_TABLE))if(!labels.has(pin.optionId))labels.set(pin.optionId,{id,label:id});
  const grouped=new Map(),seen=new Set();
  const from=Date.parse(start),until=Date.parse(end);
  for(const row of records) {
    const at=Date.parse(row.created_at);
    if(!Number.isFinite(at)||at<from||at>=until)continue;
    if(row.id && seen.has(row.id))continue;
    if(row.id)seen.add(row.id);
    const key=row.model_option_id || [row.provider,row.model].filter(Boolean).join(":") || "unknown";
    const label=labels.get(key);
    const item=grouped.get(key) || {key,modelId:label?.id || null,label:label?.label || row.model || key,
      provider:row.provider || "",calls:0,promptTokens:0,completionTokens:0,cachedTokens:0,totalTokens:0,usagePt:0,manualPt:0,roostPt:0};
    item.calls++;item.promptTokens+=numeric(row.prompt_tokens);item.completionTokens+=numeric(row.completion_tokens);
    item.cachedTokens+=numeric(row.cached_tokens);item.totalTokens+=numeric(row.total_tokens);
    const pt=numeric(row.estimated_cost_usd)*1000;item.usagePt+=pt;
    if(row.billing_lane==="manual")item.manualPt+=pt;
    if(row.billing_lane==="roost")item.roostPt+=pt;
    grouped.set(key,item);
  }
  const rows=[...grouped.values()].sort((a,b)=>b.usagePt-a.usagePt || b.calls-a.calls);
  const totals={calls:0,promptTokens:0,completionTokens:0,cachedTokens:0,totalTokens:0,usagePt:0,manualPt:0,roostPt:0};
  for(const row of rows)for(const key of Object.keys(totals))totals[key]+=row[key];
  return {rows,totals};
}
function createModelUsageCache({credentials,usage,catalog,fetch:fetchImpl=globalThis.fetch,ttl=300000,maxRows=100000}) {
  let cache=null,cacheKey=null,pending=null;
  async function read(auth,period) {
    const periodStart=period.periodStart,periodEnd=period.periodEnd;
    if(!periodStart || !periodEnd)throw new Error("Perch 未提供当前套餐的起止时间，暂时无法按套餐周期统计。");
    const snapshotAt=new Date(Math.min(Date.now(),Date.parse(periodEnd))).toISOString();
    const configRes=await fetchImpl(auth.appUrl.replace(/\/+$/,"")+"/api/perch-terminal/cli-auth/config",{signal:AbortSignal.timeout(15000)});
    if(!configRes.ok)throw new Error("无法读取 Perch 账号接口配置。");
    const config=await configRes.json();
    const base=new URL(config.supabaseUrl);
    if(base.protocol!=="https:" || !base.hostname.endsWith(".supabase.co") || !config.supabaseAnonKey)throw new Error("Perch 账号接口地址无效。");
    const records=[];let expected=null,offset=0,complete=false;
    const readStarted=Date.now();
    while(offset<maxRows) {
      if(Date.now()-readStarted>45000)break;
      const url=new URL("/rest/v1/perch_ai_inference_usage",base);
      url.searchParams.set("select","id,created_at,model_option_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cached_tokens,estimated_cost_usd,billing_lane");
      url.searchParams.set("user_id","eq."+auth.userId);
      url.searchParams.append("created_at","gte."+periodStart);
      url.searchParams.append("created_at","lt."+snapshotAt);
      url.searchParams.set("order","created_at.asc,id.asc");
      const response=await fetchImpl(url,{headers:{Authorization:"Bearer "+auth.accessToken,apikey:config.supabaseAnonKey,Accept:"application/json",Range:offset+"-"+(offset+999),...(offset===0?{Prefer:"count=exact"}:{})},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error("Perch 未能提供当前账号的模型用量明细（"+response.status+"）。");
      const page=await response.json();
      if(!Array.isArray(page))throw new Error("Perch 模型用量格式异常。");
      const count=/\/(\d+)$/.exec(response.headers.get("content-range") || "");
      if(expected===null&&count)expected=Number(count[1]);
      records.push(...page);offset+=page.length;
      if(page.length===0 || expected!==null&&offset>=expected) {complete=true;break;}
      // The server may impose a smaller page size; continue until its exact count.
      if(page.length<1000&&expected===null) {complete=true;break;}
    }
    const result=aggregateModelUsage(records,catalog.peek(),periodStart,snapshotAt);
    if(expected!==null&&result.totals.calls!==expected)complete=false;
    if(complete) {
      const existing=new Set(result.rows.map(row=>row.key));
      for(const model of catalog.peek()?.models || []) {
        if(existing.has(model.pin?.optionId))continue;
        result.rows.push({key:model.pin?.optionId || model.id,modelId:model.id,label:model.label || model.id,provider:"",calls:0,promptTokens:0,completionTokens:0,cachedTokens:0,totalTokens:0,usagePt:0,manualPt:0,roostPt:0});
      }
    }
    return {ok:true,...result,periodStart,periodEnd,snapshotAt,fetchedAt:Date.now(),expectedRecords:expected,recordCount:result.totals.calls,complete,stale:false};
  }
  async function get(options={}) {
    const auth=await credentials.get();
    if(!auth.ok){cache=null;cacheKey=null;return {ok:false,error:auth.error};}
    const period=await usage.get();
    if(!period.ok)return {ok:false,error:period.error};
    const key=[auth.appUrl,auth.userId,period.periodStart,period.periodEnd].join("|");
    if(cacheKey!==key){cache=null;cacheKey=key;}
    if(!options.force&&cache&&Date.now()-cache.fetchedAt<ttl)return cache;
    if(pending?.key===key)return pending.promise;
    const task={key,promise:null};
    task.promise=read(auth,period).then(value=>{if(cacheKey!==key)return {ok:false,error:"账号或套餐周期已改变，请刷新。"};cache=value;return value;})
      .catch(error=>cache&&cacheKey===key?{...cache,stale:true,error:error.message}:{ok:false,error:error.message})
      .finally(()=>{if(pending===task)pending=null;});
    pending=task;return task.promise;
  }
  return {get};
}
module.exports={aggregateModelUsage,createModelUsageCache};
