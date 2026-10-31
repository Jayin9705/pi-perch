"use strict";
const {evaluate}=require("./pi-eval.cjs");
async function invoke(channelKey, ...args) {
  const js = `(async()=>{const p=window.piDesktop;return p.invoke(p.channels.invoke[${JSON.stringify(channelKey)}],...${JSON.stringify(args)});})()`;
  const result = await evaluate('process.getBuiltinModule("module").createRequire(process.execPath)("electron").BrowserWindow.fromId(1).webContents.executeJavaScript('+JSON.stringify(js)+')');
  if (!result?.ok) throw new Error(JSON.stringify(result?.error || result));
  return result.data;
}
if (require.main===module) invoke(process.argv[2],...JSON.parse(process.argv[3]||"[]")).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={invoke};
