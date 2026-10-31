"use strict";
const fs=require("node:fs");
const path=require("node:path");
const PI_PROVIDER_ID="plugin:local.pi-perch:perch";
function createMappingStore(dataDir) {
  const file=path.join(dataDir,"model-mapping.json");
  let disabled=[];
  try {
    const saved=JSON.parse(fs.readFileSync(file,"utf8"));
    if(saved.version!==1 || !Array.isArray(saved.disabledModelIds) || saved.disabledModelIds.some(id=>typeof id!=="string"))throw new Error("Invalid model mapping settings");
    disabled=[...new Set(saved.disabledModelIds)];
  } catch(error) {if(error.code!=="ENOENT")throw error;}
  return {
    disabledIds(){return [...disabled];},
    isEnabled(id){return !disabled.includes(id);},
    selected(rows){return rows.filter(row=>!disabled.includes(row.id));},
    replace(ids){
      const next=[...new Set(ids)].sort();
      fs.mkdirSync(dataDir,{recursive:true});
      const tmp=file+"."+process.pid+".tmp";
      try {fs.writeFileSync(tmp,JSON.stringify({version:1,disabledModelIds:next},null,2)+"\n");fs.renameSync(tmp,file);}
      finally {fs.rmSync(tmp,{force:true});}
      disabled=next;
    },
  };
}
function saveMappingChanges(store, rows, changes, publish) {
  if(!Array.isArray(changes)||changes.length>rows.length)return {ok:false,error:"映射修改格式无效，请刷新后重试。"};
  const allowed=new Set(rows.filter(row=>!row.locked).map(row=>row.id));
  const visited=new Set(),previous=store.disabledIds(),next=new Set(previous);
  for(const change of changes) {
    if(!change || !allowed.has(change.id) || typeof change.enabled!=="boolean" || visited.has(change.id))return {ok:false,error:"只能修改当前套餐中可用模型的映射。"};
    visited.add(change.id);
    if(change.enabled)next.delete(change.id);else next.add(change.id);
  }
  try {
    store.replace([...next]);
    const result=publish();
    if(!result.ok){store.replace(previous);return result;}
    return {ok:true,changed:result.changed,selectedCount:store.selected(rows).length};
  } catch(error) {
    try {store.replace(previous);}catch{}
    return {ok:false,error:"映射保存失败："+error.message};
  }
}
function mapModels(rows, hostModels, error=null, disabledIds=[]) {
  const disabled=new Set(disabledIds);
  const known=new Map((Array.isArray(hostModels)?hostModels:[]).filter(m=>m.providerId===PI_PROVIDER_ID).map(m=>[m.modelId,m]));
  const expected=new Set(rows.filter(row=>!disabled.has(row.id)).map(row=>row.id));
  const requiresReload=!error && (expected.size!==known.size || [...expected].some(id=>!known.has(id)));
  return {providerId:PI_PROVIDER_ID,verified:!error,error,
    selectedCount:expected.size,requiresReload,
    registeredCount:error?null:rows.filter(row=>known.has(row.id)).length,
    models:rows.map(row=>({...row,piModelKey:known.get(row.id)?.key || PI_PROVIDER_ID+"/"+row.id,
      mappingEnabled:!disabled.has(row.id),piRegistered:error?null:known.has(row.id)}))};
}
module.exports={PI_PROVIDER_ID,mapModels,createMappingStore,saveMappingChanges};
