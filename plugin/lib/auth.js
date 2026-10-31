"use strict";
// The official CLI owns token refresh. A second token cache breaks rotation.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const SESSION_FILE = "cli-auth-session.json";
const AUTH_DIR = ".perch";
const REFRESH_MARGIN_MS = 120000;
function cliSessionPath() {return path.join(process.env.PERCH_CLI_AUTH_DIR || path.join(os.homedir(),AUTH_DIR),SESSION_FILE);}
function jwtExpiryMs(token) {
  try {return Number(JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()).exp)*1000 || 0;} catch {return 0;}
}
function readCliSession() {
  const file = cliSessionPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file,"utf8"));
    if (!raw.accessToken) throw new Error("missing access token");
    return {ok:true,file,source:"official-cli",appUrl:raw.appUrl || "https://app.perchai.app",accessToken:raw.accessToken,
      expiresAt:jwtExpiryMs(raw.accessToken) || Number(raw.expiresAt)*1000 || 0,userId:raw.userId || "",email:raw.email || ""};
  } catch {return {ok:false,code:"not_signed_in",error:"No Perch sign-in found. Run: perch login"};}
}
function createCredentialStore(options = {}) {
  let refreshing = null;
  let lastRefreshAttempt = 0;
  async function get(settings = {}) {
    const current = readCliSession();
    if (!current.ok) return current;
    if (!settings.force && (!current.expiresAt || current.expiresAt > Date.now()+REFRESH_MARGIN_MS)) return current;
    if (options.isReady && !options.isReady()) return {ok:false,code:"runtime_pending",error:"正在准备 Perch 组件，完成后会自动刷新登录。"};
    if (!settings.force && current.expiresAt > Date.now() && Date.now()-lastRefreshAttempt<30000) return current;
    lastRefreshAttempt=Date.now();
    if (!refreshing) refreshing = Promise.resolve().then(() => options.refreshSession()).finally(() => {refreshing=null;});
    try {await refreshing; return readCliSession();}
    catch (error) {return {ok:false,code:"reauth_required",error:"Perch CLI could not refresh sign-in: " + error.message};}
  }
  return {get,current:readCliSession};
}
module.exports = {AUTH_DIR,SESSION_FILE,REFRESH_MARGIN_MS,cliSessionPath,jwtExpiryMs,readCliSession,createCredentialStore};
