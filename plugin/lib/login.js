"use strict";
const {spawn}=require("node:child_process");
function createLoginController(options) {
  let child=null, generation=0;
  let state={state:"idle",message:"",url:null};
  return {
    status(){return {...state};},
    start(provider="google") {
      if(!["google","github"].includes(provider))return {ok:false,error:"请选择 Google 或 GitHub 登录。"};
      if(state.state==="preparing"||state.state==="waiting")return {ok:true,...state};
      const current=++generation;
      state={state:"preparing",message:"正在准备登录…",url:null};
      void (async()=>{
        const cli=await options.prepare();
        if(current!==generation)return;
        state={state:"waiting",message:"请在打开的浏览器中完成 Perch 登录。",url:null};
        await new Promise((resolve,reject)=>{
          const proc=spawn(cli.node,["--max-old-space-size=2048",cli.entry,"login",provider],{
            windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,ELECTRON_RUN_AS_NODE:"1",PERCH_CLI_HEAP_REEXEC:"1",NO_COLOR:"1"},
          });
          child=proc;
          let buffer="";
          const read=b=>{
            buffer=(buffer+b.toString()).slice(-8000);
            for(const candidate of buffer.match(/https:\/\/[^\s<>"\x1b]+/g)||[]) {
              try {const url=new URL(candidate);if(url.hostname==="app.perchai.app")state.url=url.href;}catch{}
            }
          };
          proc.stdout.on("data",read);proc.stderr.on("data",read);
          const timer=setTimeout(()=>{proc.kill();reject(new Error("登录超时，请重试。"));},300000);
          proc.once("error",e=>{clearTimeout(timer);reject(e);});
          proc.once("close",code=>{clearTimeout(timer);child=null;code===0?resolve():reject(new Error("登录未完成，请重试。"));});
        });
        if(current!==generation)return;
        if(!options.current().ok)throw new Error("未读取到登录结果，请重试。");
        state={state:"success",message:"登录成功，正在更新模型列表。",url:null};
        await options.onSuccess();
      })().catch(error=>{if(current===generation)state={state:"error",message:error.message,url:null};});
      return {ok:true,...state};
    },
    cancel(){generation++;child?.kill();child=null;state={state:"idle",message:"登录已取消。",url:null};return {ok:true};},
  };
}
module.exports={createLoginController};
