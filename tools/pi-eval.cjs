"use strict";
// Local development helper: evaluate a test in the running, user-authorized PI.
const fs = require("node:fs");
async function evaluate(expression) {
  const targets = await fetch("http://127.0.0.1:9229/json/list").then(r=>r.json());
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  try {
    return await new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(new Error("PI evaluation timed out")),60000);
      socket.addEventListener("message", e=>{
        const m=JSON.parse(e.data); if(m.id!==1)return;
        clearTimeout(timer);
        if(m.error || m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.error || m.result.exceptionDetails)));
        else resolve(m.result?.result?.value);
      });
      socket.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));
    });
  } finally { socket.close(); }
}
if(require.main===module) evaluate(fs.readFileSync(process.argv[2],"utf8")).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={evaluate};
