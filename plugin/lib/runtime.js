"use strict";
// Install the official npm release privately. The distributable plugin contains
// no copied Perch code, and does not require a global node/npm/perch command.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const PERCH_VERSION = "2.4.120";
const NPM_VERSION = "10.9.4";
const REGISTRY = "https://registry.npmjs.org";

function extractPackageTarGz(bytes, destination) {
  const tar = zlib.gunzipSync(bytes,{maxOutputLength:64*1024*1024});
  const root = path.resolve(destination);
  fs.mkdirSync(root,{recursive:true});
  for (let offset=0; offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);
    if(header.every(b=>b===0))break;
    const field=(start,length)=>header.subarray(start,start+length).toString("utf8").replace(/\0.*$/s,"");
    const name=[field(345,155),field(0,100)].filter(Boolean).join("/");
    const size=Number.parseInt(field(124,12).trim()||"0",8);
    const type=field(156,1)||"0";
    if(!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length)throw new Error("Invalid npm archive length");
    if(type==="0"||type==="5") {
      if(!name.startsWith("package/")||name.includes("\\")||name.includes(":"))throw new Error("Invalid npm archive path");
      const relative=name.slice(8);
      if(relative.split("/").some(p=>p===".."))throw new Error("Unsafe npm archive path");
      const target=path.resolve(root,relative);
      if(target!==root&&!target.startsWith(root+path.sep))throw new Error("Unsafe npm archive path");
      if(type==="5")fs.mkdirSync(target,{recursive:true});
      else {fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,tar.subarray(offset+512,offset+512+size));}
    } else if(!["x","g"].includes(type)) throw new Error("Unsupported npm archive entry type: "+type);
    offset+=512+Math.ceil(size/512)*512;
  }
}

async function fetchBytes(url) {
  const parsed=new URL(url);
  if(parsed.origin!==REGISTRY)throw new Error("Unexpected npm download host");
  const res=await fetch(parsed,{signal:AbortSignal.timeout(120000)});
  if(!res.ok)throw new Error("npm download failed ("+res.status+")");
  if(new URL(res.url).origin!==REGISTRY)throw new Error("Unexpected npm redirect");
  return Buffer.from(await res.arrayBuffer());
}

function createManagedRuntime(options) {
  const root=path.resolve(options.dataDir,"runtime");
  const npmRoot=path.join(root,"bootstrap/npm");
  const installDir=path.join(root,"perch");
  const entry=path.join(installDir,"node_modules/perchai-cli/bin/perch");
  const node=options.execPath||process.execPath;
  const readyFile=path.join(root,"ready.json");
  const lockFile=path.join(root,"install.lock");
  let inFlight=null,child=null;
  let state={state:"missing",phase:"尚未准备组件",version:PERCH_VERSION,error:null};
  function packagePresent() {
    try {
      const pkg=JSON.parse(fs.readFileSync(path.join(installDir,"node_modules/perchai-cli/package.json"),"utf8"));
      return pkg.version===PERCH_VERSION&&fs.existsSync(entry);
    } catch {return false;}
  }
  function installed() {
    try {return JSON.parse(fs.readFileSync(readyFile,"utf8")).version===PERCH_VERSION&&packagePresent();}catch{return false;}
  }
  function descriptor() {
    if(!installed())throw new Error("Perch 组件尚未准备好，请在插件面板点击准备组件。");
    return {node,entry,version:PERCH_VERSION,managed:true};
  }
  function status() {
    if(state.state!=="installing"&&installed())state={...state,state:"ready",phase:"运行组件已就绪",error:null};
    return {...state,managed:true,installDir,node};
  }
  async function install() {
    if(installed())return descriptor();
    state={state:"installing",phase:"下载官方安装组件",version:PERCH_VERSION,error:null};
    fs.mkdirSync(root,{recursive:true});
    const npmCli=path.join(npmRoot,"bin/npm-cli.js");
    if(!fs.existsSync(path.join(npmRoot,".ready"))) {
      const metadata=JSON.parse((await fetchBytes(REGISTRY+"/npm/"+NPM_VERSION)).toString("utf8"));
      if(metadata.name!=="npm"||metadata.version!==NPM_VERSION)throw new Error("Unexpected npm release");
      const bytes=await fetchBytes(metadata.dist.tarball);
      const integrity=String(metadata.dist.integrity||"").split(" ").find(s=>s.startsWith("sha512-"));
      if(!integrity||crypto.createHash("sha512").update(bytes).digest("base64")!==integrity.slice(7))throw new Error("npm archive integrity check failed");
      extractPackageTarGz(bytes,npmRoot);
      fs.writeFileSync(path.join(npmRoot,".ready"),NPM_VERSION);
    }
    state.phase="安装官方 Perch 组件（首次使用需要下载）";
    fs.mkdirSync(installDir,{recursive:true});
    fs.writeFileSync(path.join(installDir,"package.json"),JSON.stringify({name:"pi-perch-private-runtime",version:"1.0.0",private:true}));
    const config=path.join(root,"install.npmrc");
    fs.writeFileSync(config,"registry="+REGISTRY+"\nignore-scripts=true\naudit=false\nfund=false\n");
    await new Promise((resolve,reject)=>{
      let output="";
      child=spawn(node,[npmCli,"install","--prefix",installDir,"--registry",REGISTRY,"--userconfig",config,"--cache",path.join(root,"npm-cache"),"--ignore-scripts","--omit=dev","--no-audit","--no-fund","--no-package-lock","--loglevel=error","perchai-cli@"+PERCH_VERSION],{
        cwd:installDir,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},
      });
      const timer=setTimeout(()=>{child?.kill();reject(new Error("组件下载超时，请检查网络后重试。"));},240000);
      child.stdout.on("data",b=>{output=(output+b.toString()).slice(-2000);});
      child.stderr.on("data",b=>{output=(output+b.toString()).slice(-2000);});
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",code=>{clearTimeout(timer);child=null;code===0?resolve():reject(new Error("官方组件安装失败: "+output.replace(/Bearer\s+\S+/gi,"Bearer [redacted]").slice(-700)));});
    });
    if(!packagePresent())throw new Error("安装结束后未找到 Perch 组件，请重试。");
    fs.writeFileSync(readyFile+".tmp",JSON.stringify({version:PERCH_VERSION,installedAt:new Date().toISOString()}));
    fs.renameSync(readyFile+".tmp",readyFile);
    state={state:"ready",phase:"运行组件已就绪",version:PERCH_VERSION,error:null};
    return descriptor();
  }
  async function lockedInstall() {
    if(installed())return descriptor();
    fs.mkdirSync(root,{recursive:true});
    const nonce=crypto.randomUUID();
    let owned=false;
    const start=Date.now();
    try {
      while(!owned) {
        try {const fd=fs.openSync(lockFile,"wx");fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));fs.closeSync(fd);owned=true;}
        catch(error) {
          if(error.code!=="EEXIST")throw error;
          let alive=false;
          try {const owner=JSON.parse(fs.readFileSync(lockFile,"utf8"));process.kill(owner.pid,0);alive=true;}catch{}
          if(!alive){fs.rmSync(lockFile,{force:true});continue;}
          if(installed())return descriptor();
          if(Date.now()-start>300000)throw new Error("另一个安装任务尚未结束，请稍后重试。");
          state={...state,state:"installing",phase:"等待官方组件准备完成"};
          await new Promise(resolve=>setTimeout(resolve,300));
        }
      }
      return await install();
    } finally {
      if(owned) {try {if(JSON.parse(fs.readFileSync(lockFile,"utf8")).nonce===nonce)fs.rmSync(lockFile,{force:true});}catch{}}
    }
  }
  return {
    status,descriptor,
    ensure() {
      if(!inFlight)inFlight=lockedInstall().catch(error=>{state={...state,state:"error",phase:"组件准备失败",error:error.message};throw error;}).finally(()=>{inFlight=null;});
      return inFlight;
    },
    stop(){child?.kill();},
  };
}
module.exports={createManagedRuntime,extractPackageTarGz,PERCH_VERSION,NPM_VERSION};
