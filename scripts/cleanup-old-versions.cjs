#!/usr/bin/env node
/**
 * Delete old iLive Monitor installer media from whiteleyevents.co.uk (shared Whiteley Events cleanup, copied from WESC).
 *
 * Scans /wp-json/wp/v2/media for attachments in /uploads/whe-software/
 * whose filename starts with any of the given product prefixes, then
 * deletes every one NOT in the keep-list (the files just uploaded).
 *
 * Usage:
 *   node scripts/cleanup-old-versions.js \
 *     --prefix "WEIM" \
 *     --prefix "iLive-Monitor" \
 *     --prefix "iLive Monitor" \
 *     --keep release/0.5.1/WEIM-0.5.1-arm64.dmg
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const API = "https://whiteleyevents.co.uk/wp-json/wp/v2/media";
const DIRECT_PRUNE_ENDPOINT = "https://whiteleyevents.co.uk/wp-json/whe/v1/software/prune";

function loadDotEnv() {
  const p = path.resolve(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = { ...process.env, ...loadDotEnv() };
const USER = env.WELM_APP_USER, PASS = env.WELM_APP_PASSWORD;
if (!USER || !PASS) { console.error("✗ Missing WELM_APP_USER/PASSWORD in .env"); process.exit(1); }
const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const SOFTWARE_PRODUCT = sanitizeProductKey(env.WHE_UPLOAD_PRODUCT || env.WESC_UPLOAD_PRODUCT || "weim");

const prefixes = [];
const keepNames = new Set();
let dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--prefix") prefixes.push(process.argv[++i]);
  else if (a === "--keep") keepNames.add(path.basename(process.argv[++i]));
  else if (a === "--dry-run") dryRun = true; // list what would go; delete nothing
}
if (prefixes.length === 0) { console.error("Usage: --prefix <name> [--prefix ...] [--keep <file> ...]"); process.exit(1); }

function sanitizeProductKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "weim";
}

function candidateNames(basename) {
  const set = new Set([basename]);
  set.add(basename.replace(/\s+/g, "-"));
  return set;
}
const keepNormalised = new Set();
for (const n of keepNames) for (const c of candidateNames(n)) keepNormalised.add(c);

async function pruneDirectFiles() {
  const res = await fetch(DIRECT_PRUNE_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Type": "application/json",
      "X-WHE-Software-Product": SOFTWARE_PRODUCT,
    },
    body: JSON.stringify({
      product: SOFTWARE_PRODUCT,
      prefixes,
      keep: Array.from(keepNames),
    }),
  });

  const body = await res.text();
  if (res.status === 404) {
    console.warn("⚠ Direct software prune endpoint is not live; falling back to WordPress Media cleanup only.");
    return { available: false, deleted: 0, failed: 0 };
  }
  if (!res.ok) {
    console.error(`✗ direct software prune: HTTP ${res.status}`);
    console.error(`   ${extractErrorMessage(body) || "(empty body)"}`);
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (_) {
    console.error(`✗ direct software prune: unparseable response ${body.slice(0, 300)}`);
    process.exit(1);
  }

  const deleted = Array.isArray(json.deleted) ? json.deleted : [];
  const failed = Array.isArray(json.failed) ? json.failed : [];
  if (deleted.length > 0) {
    console.log(`Direct software prune deleted ${deleted.length} old file(s):`);
    for (const name of deleted) console.log(`  ✓ ${name}`);
  } else {
    console.log("Direct software prune found no old direct-uploaded files.");
  }
  if (failed.length > 0 || json.ok === false) {
    console.error(`\n✗ Direct software prune failed for ${failed.length} file(s).`);
    for (const name of failed) console.error(`  - ${name}`);
    process.exit(1);
  }
  return { available: true, deleted: deleted.length, failed: failed.length };
}

function extractErrorMessage(body) {
  const text = String(body || "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.message) return String(parsed.message);
  } catch (_) {}
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

(async () => {
  const directResult = dryRun ? { deleted: 0, available: true } : await pruneDirectFiles();
  if (dryRun) console.log("Dry run: the direct-upload prune is skipped and nothing is deleted.");
  const toDelete = [];
  let page = 1;
  let totalPages = Infinity;
  while (page <= totalPages) {
    const res = await fetch(`${API}?per_page=100&page=${page}&context=edit`, { headers: { "Authorization": auth } });
    // WordPress answers 400 rest_post_invalid_page_number past the last page (e.g. exactly 800 items → page 9):
    // that is the end of the list, not a failure.
    if (res.status === 400 && page > 1) {
      const body = await res.json().catch(() => ({}));
      if (body && body.code === "rest_post_invalid_page_number") break;
      console.error(`✗ media list page ${page}: HTTP 400 ${body && body.code ? body.code : ""}`); process.exit(1);
    }
    if (!res.ok) { console.error(`✗ media list page ${page}: HTTP ${res.status}`); process.exit(1); }
    const tp = Number(res.headers.get("x-wp-totalpages"));
    if (Number.isFinite(tp) && tp > 0) totalPages = tp;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;

    for (const it of items) {
      const url = it.source_url || "";
      const fname = path.basename(url);
      if (!url.includes("/whe-software/")) continue;
      const lower = fname.toLowerCase();
      const matchesPrefix = prefixes.some(p => {
        const pl = p.toLowerCase();
        return lower.startsWith(pl) || lower.startsWith(pl.replace(/\s+/g, "-"));
      });
      if (!matchesPrefix) continue;
      if (keepNormalised.has(fname)) continue;
      toDelete.push({ id: it.id, fname });
    }
    if (items.length < 100) break;
    page++;
  }

  if (toDelete.length === 0) {
    if (directResult.deleted > 0) {
      console.log("\n✓ Cleanup complete.");
    } else if (directResult.available) {
      console.log("✓ No old versions to remove.");
    } else {
      console.error("✗ Direct software prune endpoint is not live, so direct-uploaded installer files could not be checked or deleted.");
      process.exit(1);
    }
    return;
  }

  console.log(`Found ${toDelete.length} old file(s) to delete:`);
  for (const d of toDelete) console.log(`  - ${d.fname} (id ${d.id})`);
  if (dryRun) { console.log("\nDry run: nothing deleted."); return; }

  let failures = 0;
  for (const d of toDelete) {
    const res = await fetch(`${API}/${d.id}?force=true`, { method: "DELETE", headers: { "Authorization": auth } });
    if (!res.ok) { console.error(`✗ ${d.fname}: HTTP ${res.status}`); failures++; continue; }
    console.log(`  ✓ Deleted ${d.fname}`);
  }

  if (failures > 0) { console.error(`\n✗ ${failures} deletion(s) failed.`); process.exit(1); }
  if (!directResult.available) {
    console.error("\n✗ WordPress Media cleanup ran, but direct software prune endpoint is not live.");
    console.error("  Direct-uploaded installer files may still remain on disk.");
    process.exit(1);
  }
  console.log(`\n✓ Cleanup complete.`);
})();
