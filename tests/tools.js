"use strict";
/** Tool-call round-trip against models that support it. */
const path=require("node:path");
const {createHarness,loadPlugin}=require("./harness");
const PLUGIN_ROOT=path.join(__dirname,"..","plugin");
const TOOLS=[{type:"function",function:{name:"get_weather",description:"Get the current weather for a city",parameters:{type:"object",properties:{city:{type:"string"}},required:["city"]}}}];
const MODELS=process.argv.slice(2).length?process.argv.slice(2):["gpt-6.1-terra","deepseek-flash-starter"];
if(MODELS.length>2 || MODELS.some(m=>!/^gpt-|^deepseek/.test(m)))throw new Error("Live tests are limited to one or two DeepSeek/GPT models.");
(async()=>{
 const h=createHarness({settings:{enabled:true,preferredPort:41996,refreshSeconds:600}});
 const {plugin,restore}=loadPlugin(h,PLUGIN_ROOT);
 let fails=0;
 try{
   await plugin.onLoad();
   const st=await plugin.onPanelInvoke("perch.status",{});
   const base=st.baseUrl;
   for(const model of MODELS){
     console.log("\n--- "+model+" ---");
     // step 1: model asks for the tool
     const r1=await fetch(base+"/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model,messages:[{role:"user",content:"What is the weather in Paris? Use get_weather."}],tools:TOOLS,max_tokens:256,stream:false})});
     const b1=await r1.json();
     const call=b1.choices?.[0]?.message?.tool_calls?.[0];
     console.log("  step1:",r1.status,"finish:",b1.choices?.[0]?.finish_reason,"tool:",call?.function?.name||"none");
     if(!call){console.log("  FAIL: "+(b1.error?.message||JSON.stringify(b1.choices?.[0]?.message)||"no tool call requested"));fails++;continue;}
     // step 2: feed the result back
     const r2=await fetch(base+"/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model,messages:[
       {role:"user",content:"What is the weather in Paris? Use get_weather."},
       {role:"assistant",content:null,tool_calls:[{id:call.id,type:"function",function:{name:call.function.name,arguments:call.function.arguments}}]},
       {role:"tool",tool_call_id:call.id,content:"18C and sunny"}
     ],tools:TOOLS,max_tokens:256,stream:false})});
     const b2=await r2.json();
     const text=b2.choices?.[0]?.message?.content;
     console.log("  step2:",r2.status,"text:",text?JSON.stringify(String(text).slice(0,90)):"none");
     if(r2.status===200&&/18/.test(text)&&!b2.choices?.[0]?.message?.tool_calls?.length){console.log("  PASS");}
     else {console.log("  FAIL: "+(b2.error?.message||r2.status));fails++;}
   }
 }catch(e){console.error("FATAL",e.message);fails++;}
 finally{
   await plugin.onUnload().catch(()=>{});
   restore();h.cleanup();
   console.log(fails===0?"\nAll tool checks passed.":"\n"+fails+" failed.");
   setTimeout(()=>process.exit(fails?1:0),250);
 }
})();
