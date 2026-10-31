"use strict";
const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
function rollingRows(meter, lane) {
  if (!meter?.enabled) return [];
  return ["5h", "7d"].map(window => {
    const used = number(meter["window"+window+"Usd"]);
    const limit = number(meter["window"+window+"CapUsd"]);
    return {id:lane+"-"+window,lane,window,used,limit,
      percent:used!==null&&limit!==null&&limit>0?used/limit*100:null,
      remaining:used!==null&&limit!==null&&limit>0?Math.max(0,limit-used):null,
      nextFreedAt:date(meter["window"+window+"NextFreedAt"])};
  });
}
function normalizeAccount(account, now = Date.now()) {
  const meter=account.usageMeter || {};
  const promo=meter.promoPool;
  return {ok:true,fetchedAt:now,stale:false,planName:account.session?.planName || account.session?.planCode || "未知套餐",
    planCode:account.session?.planCode || null,periodStart:date(account.billingSubscription?.current_period_start || meter.periodStart),periodEnd:date(account.billingSubscription?.current_period_end),
    rows:[...rollingRows(meter.manualRolling,"manual"),...rollingRows(meter.roostRolling,"roost")],
    monthlyManualPt:number(meter.monthlyManualPt),creditBalancePt:number(account.creditBalancePt),
    promo:promo?{models:Array.isArray(promo.models)?promo.models.filter(m=>typeof m==="string"):[],totalPt:number(promo.amountPt),usedPt:number(promo.usedPt),leftPt:number(promo.leftPt),endsAt:date(promo.endsAt)}:null};
}
function createUsageCache({credentials,fetch:fetchImpl=globalThis.fetch,ttl=60000}) {
  let cache=null,key=null,pending=null;
  async function get(options={}) {
    const auth=await credentials.get();
    if(!auth.ok) {cache=null;key=null;return {ok:false,error:auth.error,code:auth.code};}
    const identity=auth.appUrl+"/"+auth.userId;
    if(key!==identity) {cache=null;key=identity;}
    if(!options.force && cache && Date.now()-cache.fetchedAt<ttl)return cache;
    if(pending?.identity===identity)return pending.promise;
    const task={identity,promise:null};
    task.promise=(async()=>{
      try {
        const res=await fetchImpl(auth.appUrl.replace(/\/+$/,"")+"/api/perchai/account",{headers:{Accept:"application/json",Authorization:"Bearer "+auth.accessToken,"User-Agent":"pi-perch/0.3.0"},signal:AbortSignal.timeout(15000)});
        if(!res.ok)throw new Error("读取 Perch 额度失败（"+res.status+"）");
        const body=await res.json();
        if(body.ok!==true||!body.session)throw new Error("Perch 未返回账号额度数据。");
        const result=normalizeAccount(body);
        if(key!==identity)return {ok:false,error:"账号已切换，请刷新额度。"};
        cache=result;
        return result;
      } catch(error) {return cache&&key===identity?{...cache,stale:true,error:error.message}:{ok:false,error:error.message};}
      finally {if(pending===task)pending=null;}
    })();
    pending=task;return task.promise;
  }
  return {get,invalidate(){cache=null;}};
}
module.exports={rollingRows,normalizeAccount,createUsageCache};
