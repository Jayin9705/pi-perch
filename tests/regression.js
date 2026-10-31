"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {decodeToolReply,bridgePrompt} = require("../plugin/lib/cli");
const {translateMessages} = require("../plugin/lib/adapter");
const {createStreamTranslator} = require("../plugin/lib/stream");
const {createCredentialStore} = require("../plugin/lib/auth");
const {normalizeAccount,createUsageCache} = require("../plugin/lib/usage");
const {mapModels,PI_PROVIDER_ID,createMappingStore,saveMappingChanges} = require("../plugin/lib/mapping");
const {providerDeclaration,writeDeclaration,readDeclaredProviders}=require("../plugin/lib/declaration");
const {extractPackageTarGz} = require("../plugin/lib/runtime");
const zlib=require("node:zlib");
const {aggregateModelUsage,createModelUsageCache}=require("../plugin/lib/model-usage");
const tools = [{type:"function",function:{name:"read_file",parameters:{type:"object"}}}];
test("OpenAI nested tool names survive CLI round-trip; unknown tools are rejected", () => {
  const value = decodeToolReply('{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"中文.txt"}}]}',tools);
  assert.equal(value.toolCalls[0].name,"read_file");
  assert.equal(value.toolCalls[0].arguments.path,"中文.txt");
  assert.throws(() => decodeToolReply('{"content":"","tool_calls":[{"name":"delete_all","arguments":{}}]}',tools), /未知工具/);
  assert.throws(() => decodeToolReply('{"content":"done","tool_calls":[]}',tools,"required"), /工具选择/);
});
test("image-only messages are not dropped", () => {
  const image = {type:"image_url",image_url:{url:"data:image/png;base64,aGVsbG8="}};
  const translated = translateMessages([{role:"user",content:[image]}]);
  assert.equal(translated.messages.length,1);
  const prompt = bridgePrompt({request:translated});
  assert.deepEqual(prompt[1],{type:"image",mimeType:"image/png",data:"aGVsbG8="});
});
test("tool results remain available with their original call id", () => {
  const messages = translateMessages([{role:"assistant",content:null,tool_calls:[{id:"call1",type:"function",function:{name:"read_file",arguments:'{"path":"a"}'}}]},{role:"tool",tool_call_id:"call1",content:"actual file data"}]);
  const prompt = bridgePrompt({request:{...messages,tools}})[0].text;
  assert.match(prompt,/actual file data/);
  assert.match(prompt,/call1/);
});
test("stream errors and truncation cannot masquerade as successful completions", () => {
  const stream = createStreamTranslator({model:"test"});
  const out = stream.push(Buffer.from('data: {"type":"error","message":"denied","code":"cli_refused"}\n\n')) + stream.end();
  assert.match(out,/cli_refused/);
  assert.doesNotMatch(out,/finish_reason/);
  assert.equal((out.match(/\[DONE\]/g)||[]).length,1);
  assert.match(createStreamTranslator({model:"test"}).end(),/incomplete_stream/);
});
test("final SSE event without newline is flushed", () => {
  const stream = createStreamTranslator({model:"test"});
  const out = stream.push(Buffer.from('data: {"type":"done","text":"ok","finishReason":"stop"}')) + stream.end();
  assert.match(out,/"content":"ok"/);
  assert.match(out,/\[DONE\]/);
  assert.doesNotMatch(out,/incomplete_stream/);
});
test("logging out clears bridge access; refresh is delegated once to CLI", async () => {
  const previous = process.env.PERCH_CLI_AUTH_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"pi-perch-auth-test-"));
  process.env.PERCH_CLI_AUTH_DIR = dir;
  const file = path.join(dir,"cli-auth-session.json");
  const expired = "x."+Buffer.from(JSON.stringify({exp:1})).toString("base64url")+".x";
  fs.writeFileSync(file,JSON.stringify({accessToken:expired}));
  let refreshed = 0;
  const store = createCredentialStore({refreshSession:async () => {
    refreshed++;
    const token = "x."+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString("base64url")+".x";
    fs.writeFileSync(file,JSON.stringify({accessToken:token}));
  }});
  try {
    const results = await Promise.all([store.get(),store.get()]);
    assert.ok(results.every(r=>r.ok)); assert.equal(refreshed,1);
    fs.unlinkSync(file); assert.equal((await store.get()).ok,false);
  } finally {
    if (previous === undefined) delete process.env.PERCH_CLI_AUTH_DIR; else process.env.PERCH_CLI_AUTH_DIR=previous;
    if (path.dirname(path.resolve(dir)) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("pi-perch-auth-test-")) fs.rmSync(dir,{recursive:true,force:true});
  }
});
test("quota lanes and rolling release times are not confused with reset times",()=>{
  const usage=normalizeAccount({session:{planName:"Pro"},usageMeter:{manualRolling:{enabled:true,window5hUsd:5,window5hCapUsd:10,window5hNextFreedAt:"2026-11-01T10:00:00Z",window7dUsd:0},roostRolling:{enabled:true,window5hUsd:1,window5hCapUsd:4}}});
  assert.equal(usage.rows.find(r=>r.id==="manual-5h").percent,50);
  assert.equal(usage.rows.find(r=>r.id==="roost-5h").percent,25);
  assert.equal(usage.rows.find(r=>r.id==="manual-7d").percent,null);
  assert.equal(usage.rows[0].nextFreedAt,"2026-11-01T10:00:00Z");
  assert.equal(usage.creditBalancePt,null);
});
test("PI mapping uses actual provider identity and never assumes registration",()=>{
  const rows=[{id:"gpt-x"},{id:"deepseek-x"}];
  const mapping=mapModels(rows,[{providerId:PI_PROVIDER_ID,modelId:"gpt-x",key:PI_PROVIDER_ID+"/gpt-x"},{providerId:"other-provider",modelId:"deepseek-x"}]);
  assert.equal(mapping.registeredCount,1);assert.equal(mapping.models[1].piRegistered,false);
  assert.equal(mapModels(rows,[],"permission unavailable").models[0].piRegistered,null);
});
test("npm bootstrap refuses archive traversal before writing files",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"pi-perch-tar-test-"));
  const header=Buffer.alloc(1024);header.write("package/../escaped");header.write("00000000000",124);header.write("0",156);
  try {assert.throws(()=>extractPackageTarGz(zlib.gzipSync(header),dir),/Unsafe npm archive path/);}
  finally {fs.rmdirSync(dir);}
});
test("per-model usage follows subscription boundaries and deduplicates rows",()=>{
  const base={model_option_id:"pin",model:"model",prompt_tokens:10,completion_tokens:2,cached_tokens:5,total_tokens:12,estimated_cost_usd:0.003,billing_lane:"manual"};
  const first={...base,id:"one",created_at:"2026-10-12T15:30:43Z"};
  const records=[first,first,{...base,id:"two",created_at:"2026-11-01T00:00:00Z"},{...base,id:"before",created_at:"2026-10-12T15:30:42Z"},{...base,id:"after",created_at:"2026-11-12T15:30:43Z"}];
  const result=aggregateModelUsage(records,{models:[{id:"model-id",label:"Model label",pin:{optionId:"pin"}}]},"2026-10-12T15:30:43Z","2026-11-12T15:30:43Z");
  assert.equal(result.totals.calls,2);assert.equal(result.totals.totalTokens,24);assert.equal(result.totals.cachedTokens,10);
  assert.equal(result.rows[0].label,"Model label");assert.equal(result.totals.usagePt,6);
});
test("an account switch cannot reuse another account's pending quota response",async()=>{
  let user="first";const pending=new Map();
  const cache=createUsageCache({credentials:{get:async()=>({ok:true,userId:user,appUrl:"https://app.perchai.app",accessToken:user})},fetch:async(_url,init)=>new Promise(resolve=>pending.set(init.headers.Authorization,resolve))});
  const first=cache.get();await new Promise(resolve=>setImmediate(resolve));user="second";
  const second=cache.get();await new Promise(resolve=>setImmediate(resolve));
  pending.get("Bearer second")({ok:true,json:async()=>({ok:true,session:{planName:"second"}})});
  assert.equal((await second).planName,"second");
  pending.get("Bearer first")({ok:true,json:async()=>({ok:true,session:{planName:"first"}})});
  assert.equal((await first).ok,false);
});
test("account ledger paginates even when server pages are smaller than requested",async()=>{
  const ranges=[];const records=Array.from({length:5},(_,i)=>({id:String(i),created_at:"2026-10-20T00:00:00Z",model:"model",total_tokens:1}));
  const cache=createModelUsageCache({credentials:{get:async()=>({ok:true,userId:"only-this-user",appUrl:"https://app.perchai.app",accessToken:"test"})},usage:{get:async()=>({ok:true,periodStart:"2026-10-12T15:30:43Z",periodEnd:"2026-11-12T15:30:43Z"})},catalog:{peek:()=>({models:[]})},fetch:async(url,init)=>{
    if(String(url).includes("cli-auth/config"))return {ok:true,json:async()=>({supabaseUrl:"https://test.supabase.co",supabaseAnonKey:"public"})};
    assert.equal(new URL(url).searchParams.get("user_id"),"eq.only-this-user");
    const offset=Number(init.headers.Range.split("-")[0]);ranges.push(offset);
    return {ok:true,headers:{get:()=>offset===0?"0-1/5":"*"},json:async()=>records.slice(offset,offset+2)};
  }});
  const result=await cache.get();assert.equal(result.complete,true);assert.equal(result.totals.calls,5);assert.deepEqual(ranges,[0,2,4]);
});
test("mapping changes survive reload/refresh, allow all-off, and roll back failed writes",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"pi-perch-map-test-"));
  try {
    const rows=[{id:"deepseek-test",name:"DS"},{id:"gpt-test",name:"GPT"}];
    fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({id:"local.pi-perch",permissions:["provider.register"],contributes:{providers:[]}}));
    let store=createMappingStore(dir);
    const publish=()=>writeDeclaration(dir,providerDeclaration({models:store.selected(rows)},"http://127.0.0.1:41891"));
    assert.equal(saveMappingChanges(store,rows,[{id:"gpt-test",enabled:false}],publish).ok,true);
    assert.deepEqual(readDeclaredProviders(dir)[0].models.map(m=>m.id),["deepseek-test"]);
    store=createMappingStore(dir);
    assert.equal(store.isEnabled("gpt-test"),false);
    assert.deepEqual(store.selected([...rows,{id:"new-model"}]).map(m=>m.id),["deepseek-test","new-model"]);
    assert.equal(saveMappingChanges(store,rows,[{id:"deepseek-test",enabled:false}],publish).ok,true);
    assert.deepEqual(readDeclaredProviders(dir),[]);
    const failed=saveMappingChanges(store,rows,[{id:"gpt-test",enabled:true}],()=>({ok:false,error:"read-only package"}));
    assert.equal(failed.ok,false);
    assert.equal(createMappingStore(dir).isEnabled("gpt-test"),false);
    assert.equal(saveMappingChanges(store,rows,[{id:"not-on-plan",enabled:true}],publish).ok,false);
    assert.equal(saveMappingChanges(store,rows,[{id:"gpt-test",enabled:true}],publish).ok,true);
    assert.deepEqual(readDeclaredProviders(dir)[0].models.map(m=>m.id),["gpt-test"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,"manifest.json"),"utf8")).permissions,["provider.register"]);
  } finally {
    if(path.dirname(path.resolve(dir))===path.resolve(os.tmpdir())&&path.basename(dir).startsWith("pi-perch-map-test-"))fs.rmSync(dir,{recursive:true,force:true});
  }
});
test("intentional hidden models do not look like missing PI registrations",()=>{
  const rows=[{id:"deepseek-test"},{id:"gpt-test"}];
  const host=[{providerId:PI_PROVIDER_ID,modelId:"deepseek-test",key:PI_PROVIDER_ID+"/deepseek-test"}];
  const correct=mapModels(rows,host,null,["gpt-test"]);
  assert.equal(correct.selectedCount,1);assert.equal(correct.requiresReload,false);
  assert.equal(correct.models[1].mappingEnabled,false);
  assert.equal(mapModels(rows,host,null,[]).requiresReload,true);
  assert.equal(mapModels(rows,[],null,rows.map(r=>r.id)).requiresReload,false);
});
