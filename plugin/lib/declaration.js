"use strict";

/**
 * Publish the provider declaration into this plugin's own manifest.
 *
 * `contributes.providers` is the only channel a plugin has for putting models into
 * PI's model list: the host reads it from the manifest when the plugin loads. So the
 * plugin keeps its manifest in sync with the live Perch catalog, rewriting just that
 * one key when the catalog changed.
 *
 * The rewrite is deliberately narrow:
 *  - only `contributes.providers` is touched; every other key, and its order, stays
 *    as the user or the packer left it;
 *  - the write is atomic (temp file + rename) so a crash mid-write cannot leave a
 *    half-written manifest behind;
 *  - the comparison is done on canonically-ordered JSON, so a semantically identical
 *    declaration written with different key order does not cause a write, and the
 *    plugin does not churn the file on every load.
 */

const fs = require("node:fs");
const path = require("node:path");

const PROVIDER_ID = "perch";
const PROVIDER_NAME = "Perch";

/**
 * Canonical JSON: object keys sorted, arrays in order.
 *
 * Two declarations that mean the same thing must compare equal regardless of how
 * they were spelled, or the manifest is rewritten on every load and the panel keeps
 * claiming the model list just changed.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * One model row as `contributes.providers[].models[]` wants it.
 *
 * `id` is what PI shows and what arrives as `body.model`; the plugin maps it back to
 * a Perch pin from its own catalog. The capability fields are the ones the host
 * reads to decide what it may put in a request.
 */
function modelDeclaration(row) {
  const declaration = {
    id: row.id,
    name: row.name,
    alias: row.alias ?? row.name,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    supportsImages: row.supportsImages === true,
  };
  if (Array.isArray(row.thinkingLevels) && row.thinkingLevels.length > 0) {
    declaration.thinkingLevels = row.thinkingLevels.slice();
    declaration.defaultThinkingLevel = row.defaultThinkingLevel;
  }
  if (row.keepsData === true) declaration.keepsData = true;
  if (typeof row.retentionNotice === "string" && row.retentionNotice !== "") {
    declaration.retentionNotice = row.retentionNotice;
  }
  return declaration;
}

/**
 * The provider block for a running server.
 *
 * A provider with an empty model list is rejected by the host, so when the catalog
 * is empty this returns null and the caller leaves the previous declaration alone.
 */
function providerDeclaration(catalog, baseUrl) {
  const rows = Array.isArray(catalog?.models) ? catalog.models : [];
  if (rows.length === 0) return null;
  const url = String(baseUrl ?? "").replace(/\/+$/, "");
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: url + "/v1",
    apiStyle: "chat_completions",
    // The plugin's own server holds the credential; the host sends none. PI strips
    // its placeholder key when it sees this, so no fake key leaks into a request.
    authKind: "none",
    models: rows.map(modelDeclaration),
  };
}

/**
 * Write the declaration into the plugin's manifest.
 *
 * Returns `{ ok, changed, error? }`. A failure is reported, never thrown: a plugin
 * whose manifest could not be updated still serves calls, the model list is just
 * whatever the last successful write left.
 */
function writeDeclaration(packageRoot, declaration) {
  if (!packageRoot) return { ok: false, changed: false, error: "the plugin package path is unknown" };
  const manifestPath = path.join(packageRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, changed: false, error: "manifest.json could not be read (" + errorCodeOf(error) + ")" };
  }
  const providers = declaration === null ? [] : [declaration];
  const previous = canonicalJson(manifest.contributes?.providers ?? []);
  const next = canonicalJson(providers);
  if (previous === next) return { ok: true, changed: false, providerCount: providers.length };
  manifest.contributes = manifest.contributes ?? {};
  manifest.contributes.providers = providers;
  const temporary = manifestPath + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* nothing to clean up */
    }
    return { ok: false, changed: false, error: "manifest.json could not be written (" + errorCodeOf(error) + ")" };
  }
  return { ok: true, changed: true, providerCount: providers.length };
}

function errorCodeOf(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
}

/** The providers the manifest currently declares for this plugin. */
function readDeclaredProviders(packageRoot) {
  if (!packageRoot) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));
    const providers = manifest?.contributes?.providers;
    return Array.isArray(providers) ? providers : [];
  } catch {
    return [];
  }
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_NAME,
  canonicalJson,
  modelDeclaration,
  providerDeclaration,
  readDeclaredProviders,
  writeDeclaration,
};
