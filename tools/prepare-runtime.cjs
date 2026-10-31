"use strict";
const path=require("node:path");
const {createManagedRuntime}=require("../plugin/lib/runtime");
process.env.PATH=process.platform==="win32"?"C:\\Windows\\System32;C:\\Windows":"/usr/bin:/bin";
const dataDir=path.resolve(process.argv[2]||".standalone-test-data");
const runtime=createManagedRuntime({dataDir});
const timer=setInterval(()=>console.log(runtime.status().phase),10000);
runtime.ensure().then(cli=>console.log(JSON.stringify({ok:true,engine:process.versions.node,usesElectron:Boolean(process.versions.electron),...cli}))).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearInterval(timer));
