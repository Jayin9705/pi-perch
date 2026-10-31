"use strict";
const path=require("node:path");
const {spawnSync}=require("node:child_process");
const {createCliClient}=require("../plugin/lib/cli");
const {readCliSession}=require("../plugin/lib/auth");
const {pinFor}=require("../plugin/lib/catalog");
process.env.PATH=process.platform==="win32"?"C:\\Windows\\System32;C:\\Windows":"/usr/bin:/bin";
const dataDir=path.resolve(process.argv[2]||".standalone-test-data");
const client=createCliClient({dataDir});
const model=process.argv[3] || "gpt-6.1-terra";
if(!/^deepseek|^gpt-/.test(model))throw new Error("Only DS/GPT may be used in live tests.");
(async()=>{
  await client.prepare();
  const where=spawnSync("where.exe",["perch"],{encoding:"utf8",windowsHide:true});
  if(process.platform==="win32"&&where.status===0)throw new Error("global perch unexpectedly on PATH");
  const answer=await client.call({manualModelOptionId:pinFor(model).optionId,reasoning:{enableThinking:false},request:{messages:[{role:"user",content:"Reply with exactly: PI_STANDALONE_OK. Do not use tools."}]}},{timeoutMs:90000});
  if(!answer.text.includes("PI_STANDALONE_OK"))throw new Error("Unexpected answer: "+answer.text);
  const saved=process.env.PERCH_CLI_AUTH_DIR;
  process.env.PERCH_CLI_AUTH_DIR=path.join(dataDir,"empty-auth-profile");
  try {if(readCliSession().ok)throw new Error("Clean profile unexpectedly signed in");}
  finally {if(saved===undefined)delete process.env.PERCH_CLI_AUTH_DIR;else process.env.PERCH_CLI_AUTH_DIR=saved;}
  console.log(JSON.stringify({ok:true,model,globalPerchOnPath:false,engine:process.versions.node,usesElectron:Boolean(process.versions.electron),runtime:client.runtimeStatus(),reply:answer.text,cleanProfileRequiresLogin:true},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>client.close());
