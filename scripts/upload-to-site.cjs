#!/usr/bin/env node
/**
 * Upload iLive Monitor installer artefacts to whiteleyevents.co.uk using an
 * application password. Shared Whiteley Events uploader (copied from WEDM).
 * The preferred endpoint streams directly into
 * /uploads/whe-software/; the WordPress Media endpoint is kept as a fallback.
 *
 * Credentials are read from .env at the repo root (gitignored):
 *   WELM_APP_USER=<WordPress username>
 *   WELM_APP_PASSWORD=<application password, spaces allowed>
 *
 * The site's theme routes uploads into product/platform folders under
 * /uploads/whe-software/ so the product scanner picks them up.
 *
 * Usage:
 *   node scripts/upload-to-site.cjs release/<version>/WEIM-<version>-arm64.dmg
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const ENDPOINT = "https://whiteleyevents.co.uk/wp-json/wp/v2/media";
const DIRECT_ENDPOINT = "https://whiteleyevents.co.uk/wp-json/whe/v1/software/upload";
const PRUNE_ENDPOINT = "https://whiteleyevents.co.uk/wp-json/whe/v1/software/prune";
const PUBLIC_BASE = "https://whiteleyevents.co.uk/wp-content/uploads/whe-software";

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
if (!USER || !PASS) { console.error("✗ Missing WELM_APP_USER or WELM_APP_PASSWORD in .env"); process.exit(1); }
const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
function envValue(name, legacyName, fallback) {
  return env[name] !== undefined ? env[name] : (env[legacyName] !== undefined ? env[legacyName] : fallback);
}

const SOFTWARE_PRODUCT = sanitizeProductKey(envValue("WHE_UPLOAD_PRODUCT", "WESC_UPLOAD_PRODUCT", "weim"));
const UPLOAD_TIMEOUT_MS = clampInt(envValue("WHE_UPLOAD_TIMEOUT_MS", "WESC_UPLOAD_TIMEOUT_MS", 20 * 60 * 1000), 20 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const UPLOAD_RETRIES = clampInt(envValue("WHE_UPLOAD_RETRIES", "WESC_UPLOAD_RETRIES", 3), 3, 1, 8);
const VERIFY_ATTEMPTS = clampInt(envValue("WHE_UPLOAD_VERIFY_ATTEMPTS", "WESC_UPLOAD_VERIFY_ATTEMPTS", 18), 18, 1, 60);
const VERIFY_DELAY_MS = clampInt(envValue("WHE_UPLOAD_VERIFY_DELAY_MS", "WESC_UPLOAD_VERIFY_DELAY_MS", 10000), 10000, 1000, 60000);
const DIRECT_CHUNK_SIZE = clampInt(envValue("WHE_UPLOAD_CHUNK_SIZE_MB", "WESC_UPLOAD_CHUNK_SIZE_MB", 4), 4, 1, 1024) * 1024 * 1024;
const DIRECT_CHUNK_RETRIES = clampInt(envValue("WHE_UPLOAD_CHUNK_RETRIES", "WESC_UPLOAD_CHUNK_RETRIES", 5), 5, 1, 12);
const ALLOW_DIRECT_CHUNKS = /^(1|true|yes)$/i.test(String(envValue("WHE_UPLOAD_ALLOW_CHUNKS", "WESC_UPLOAD_ALLOW_CHUNKS", "0")));
const USE_DIRECT_ENDPOINT = !/^(0|false|no)$/i.test(String(envValue("WHE_UPLOAD_DIRECT", "WESC_UPLOAD_DIRECT", "1")));
const PRUNE_OLD_RELEASES = /^(1|true|yes)$/i.test(String(envValue("WHE_UPLOAD_PRUNE", "WESC_UPLOAD_PRUNE", "0")));
let uploadDispatcher = null;
let directEndpointAvailable = null;

try {
  const { Agent } = require("undici");
  uploadDispatcher = new Agent({
    headersTimeout: UPLOAD_TIMEOUT_MS,
    bodyTimeout: UPLOAD_TIMEOUT_MS,
    connectTimeout: 30000,
  });
} catch (_) {
  uploadDispatcher = null;
}

function mimeFor(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".dmg"))      return "application/x-apple-diskimage";
  if (n.endsWith(".sha256"))   return "text/plain";
  if (n.endsWith(".zip"))      return "application/zip";
  if (n.endsWith(".exe"))      return "application/vnd.microsoft.portable-executable";
  if (n.endsWith(".appimage")) return "application/x-executable";
  if (n.endsWith(".deb"))      return "application/vnd.debian.binary-package";
  return "application/octet-stream";
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeProductKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "weim";
}

function productFolder(productKey) {
  const known = {
    wedm: "Whiteley-Events-Decibel-Meter",
    weim: "Whiteley-Events-AH-iLive-Monitor",
    wesc: "WESC",
    westc: "WESTc",
    "stage-timer": "Stage-Timer",
  };
  return known[productKey] || productKey.replace(/[_\s]+/g, "-");
}

function uploadBucketFor(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".exe") || n.endsWith(".exe.sha256") || n.endsWith(".msi") || n.endsWith(".exe.zip") || n.includes("windows") || /(?:^|[-_])win(?:[-_]|$)/.test(n)) {
    return "Windows";
  }
  if (n.endsWith(".dmg") || n.endsWith(".dmg.sha256") || n.endsWith(".pkg") || /mac[-_]/.test(n) || (/(?:^|[\W_])(arm64|x64|intel|apple[\W_]?silicon)(?:[\W_]|$)/.test(n) && n.endsWith(".zip"))) {
    return "MAC";
  }
  if (n.endsWith(".pdf")) {
    return "DOCS";
  }
  return "";
}

function encodePath(relativePath) {
  return relativePath.split("/").map(part => encodeURIComponent(part)).join("/");
}

function publicFilenameFor(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function publicUrlFor(name) {
  const parts = [productFolder(SOFTWARE_PRODUCT)];
  const bucket = uploadBucketFor(name);
  if (bucket) parts.push(bucket);
  parts.push(publicFilenameFor(name));
  return `${PUBLIC_BASE}/${encodePath(parts.join("/"))}`;
}

function versionFromFilename(name) {
  const match = String(name || "").match(/\b(\d+\.\d+\.\d+)(?:[-.][A-Za-z0-9]+)?\b/);
  return match ? match[1] : null;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
    return await fetch(url, {
      ...opts,
      headers: {
        "Connection": "close",
        ...(opts.headers || {}),
      },
      signal: controller.signal,
      // Node 20's built-in fetch rejects an Agent created by newer undici releases
      // with UND_ERR_INVALID_ARG for large request bodies. Its native dispatcher
      // already provides adequate streaming and timeout handling here.
      ...(uploadDispatcher && nodeMajor >= 22 ? { dispatcher: uploadDispatcher } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyUploaded(name, attempts = VERIFY_ATTEMPTS) {
  const url = publicUrlFor(name);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(VERIFY_DELAY_MS);
    try {
      const res = await fetchWithTimeout(url, {
        method: "HEAD",
        cache: "no-store",
      });
      if (res.ok) return url;
    } catch (_) {}
  }
  return null;
}

async function uploadOneAttempt(filePath) {
  const name = path.basename(filePath);
  const size = fs.statSync(filePath).size;

  console.log(`→ Uploading ${name} (${(size / 1024 / 1024).toFixed(1)} MB)…`);

  if (await canUseDirectEndpoint()) {
    const direct = await uploadOneDirectAttempt(filePath, name, size);
    if (direct && direct.ok) return direct;
    if (direct && direct.fatal) return direct;
  } else {
    console.warn(`  direct software upload endpoint is not live; using WordPress Media API.`);
  }

  return uploadOneMediaAttempt(filePath, name);
}

async function canUseDirectEndpoint() {
  if (!USE_DIRECT_ENDPOINT) return false;
  if (directEndpointAvailable !== null) return directEndpointAvailable;
  try {
    const res = await fetchWithTimeout(DIRECT_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "X-WHE-Software-Probe": "1",
      },
      body: "",
    });
    const body = await res.text();
    directEndpointAvailable = res.status === 400 && /whe_bad_filename|Invalid filename/i.test(body);
  } catch (_) {
    directEndpointAvailable = false;
  }
  return directEndpointAvailable;
}

async function uploadOneDirectAttempt(filePath, name, size) {
  if (ALLOW_DIRECT_CHUNKS && size > DIRECT_CHUNK_SIZE) {
    return uploadOneDirectChunked(filePath, name, size);
  }
  if (size > DIRECT_CHUNK_SIZE) {
    console.log(`  direct chunking disabled; uploading ${name} as one complete installer file`);
  }
  return uploadOneDirectWhole(filePath, name, size);
}

async function uploadOneDirectWhole(filePath, name, size) {
  const res = await fetchWithTimeout(DIRECT_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization":            auth,
      "Content-Type":             mimeFor(name),
      "Content-Length":           String(size),
      "Content-Disposition":      `attachment; filename="${name}"`,
      "X-WHE-Software-Product":   SOFTWARE_PRODUCT,
      "X-WHE-Software-Filename":  name,
    },
    body: fs.createReadStream(filePath),
    duplex: "half",
  });

  const body = await res.text();
  if (!res.ok) {
    const msg = extractErrorMessage(body);
    console.error(`✗ ${name}: direct HTTP ${res.status}\n   ${msg || "(empty body)"}`);
    if (/Could not match file to a software product/i.test(msg || "")) {
      return { ok: false, fatal: true, error: msg || `direct HTTP ${res.status}` };
    }
    const endpointMissing = res.status === 404 || res.status === 405 || res.status === 501;
    return { ok: false, fatal: false, error: msg || `direct HTTP ${res.status}` };
  }

  try {
    const j = JSON.parse(body);
    const url = j.url || j.source_url || "(no url)";
    const expectedUrl = publicUrlFor(name);
    const ok = normaliseUrlPath(url) === normaliseUrlPath(expectedUrl);
    console.log(`  ${ok ? "✓" : "⚠"} ${name} → ${url}`);
    if (!ok) console.warn(`  (expected ${expectedUrl} — website upload endpoint may need updating)`);
    return { ok, url };
  } catch (_) {
    console.error(`✗ ${name}: unparseable direct response ${body.slice(0, 200)}`);
    return { ok: false, fatal: true, error: "unparseable direct response" };
  }
}

async function uploadOneDirectChunked(filePath, name, size) {
  const uploadId = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`.replace(/[^a-zA-Z0-9_-]/g, "");
  const chunks = Math.ceil(size / DIRECT_CHUNK_SIZE);
  console.log(`  using chunked upload: ${chunks} x ${(DIRECT_CHUNK_SIZE / 1024 / 1024).toFixed(0)} MB max`);

  for (let index = 0; index < chunks; index++) {
    const start = index * DIRECT_CHUNK_SIZE;
    const end = Math.min(size, start + DIRECT_CHUNK_SIZE) - 1;
    const chunkSize = end - start + 1;
    const chunkBuffer = Buffer.allocUnsafe(chunkSize);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, chunkBuffer, 0, chunkSize, start);
    } finally {
      fs.closeSync(fd);
    }
    const payload = chunkBuffer.toString("base64");
    const chunkHeaders = {
      "Authorization":                  auth,
      // Some shared hosting front-ends stop responding after several reused
      // large request bodies. A fresh connection for each part is reliable.
      "Connection":                     "close",
      "Content-Type":                   "text/plain; charset=us-ascii",
      "Content-Disposition":            `attachment; filename="${name}"`,
      "X-WHE-Software-Product":         SOFTWARE_PRODUCT,
      "X-WHE-Software-Filename":        name,
      "X-WHE-Software-Chunk":           "1",
      "X-WHE-Software-Chunk-Encoding":  "base64",
      "X-WHE-Software-Chunk-Bytes":     String(chunkSize),
      "X-WHE-Software-Upload-Id":       uploadId,
      "X-WHE-Software-Chunk-Index":     String(index),
      "X-WHE-Software-Chunk-Offset":    String(start),
      "X-WHE-Software-Chunk-Count":     String(chunks),
      "X-WHE-Software-Total-Size":      String(size),
      "X-WHE-Software-Final-Chunk":     "0",
    };

    let res = null;
    let body = "";
    for (let attempt = 1; attempt <= DIRECT_CHUNK_RETRIES; attempt++) {
      try {
        res = await fetchWithTimeout(DIRECT_ENDPOINT, {
          method: "POST",
          headers: chunkHeaders,
          body: Buffer.from(payload, "ascii"),
        });
        body = await res.text();
        if (res.ok) break;
      } catch (err) {
        const message = err && err.cause && err.cause.code
          ? `${err.message} (${err.cause.code})`
          : (err && err.message ? err.message : String(err));
        if (attempt === DIRECT_CHUNK_RETRIES) {
          console.error(`✗ ${name}: direct chunk ${index + 1}/${chunks} failed after ${attempt} tries\n   ${message}`);
          return { ok: false, fatal: false, error: message };
        }
        const waitMs = Math.min(30000, 2000 * attempt);
        console.warn(`⚠ ${name}: chunk ${index + 1}/${chunks} try ${attempt}/${DIRECT_CHUNK_RETRIES} failed: ${message}; retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok && attempt < DIRECT_CHUNK_RETRIES) {
        const msg = extractErrorMessage(body);
        const waitMs = Math.min(30000, 2000 * attempt);
        console.warn(`⚠ ${name}: chunk ${index + 1}/${chunks} HTTP ${res.status} on try ${attempt}/${DIRECT_CHUNK_RETRIES}: ${msg || "(empty body)"}; retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }

    if (!res || !res.ok) {
      const msg = extractErrorMessage(body);
      console.error(`✗ ${name}: direct chunk ${index + 1}/${chunks} HTTP ${res ? res.status : "unknown"}\n   ${msg || "(empty body)"}`);
      const status = res ? res.status : "unknown";
      return { ok: false, fatal: false, error: msg || `direct chunk HTTP ${status}` };
    }

    let j = null;
    try {
      j = JSON.parse(body);
    } catch (_) {
      return { ok: false, fatal: true, error: `unparseable chunk response: ${body.slice(0, 200)}` };
    }

    const pct = Math.round(((index + 1) / chunks) * 100);
    console.log(`  chunk ${index + 1}/${chunks} uploaded (${pct}%)`);
  }

  const res = await fetchWithTimeout(DIRECT_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization":                  auth,
      "Connection":                     "close",
      "Content-Type":                   mimeFor(name),
      "Content-Disposition":            `attachment; filename="${name}"`,
      "X-WHE-Software-Product":         SOFTWARE_PRODUCT,
      "X-WHE-Software-Filename":        name,
      "X-WHE-Software-Chunk":           "1",
      "X-WHE-Software-Upload-Id":       uploadId,
      "X-WHE-Software-Chunk-Index":     String(chunks),
      "X-WHE-Software-Chunk-Offset":    String(size),
      "X-WHE-Software-Chunk-Count":     String(chunks),
      "X-WHE-Software-Total-Size":      String(size),
      "X-WHE-Software-Final-Chunk":     "1",
      "X-WHE-Software-Finalise-Only":   "1",
    },
    body: Buffer.alloc(0),
  });

  const body = await res.text();
  if (!res.ok) {
    const msg = extractErrorMessage(body);
    console.error(`✗ ${name}: direct finalise HTTP ${res.status}\n   ${msg || "(empty body)"}`);
    return { ok: false, fatal: false, error: msg || `direct finalise HTTP ${res.status}` };
  }

  let j = null;
  try {
    j = JSON.parse(body);
  } catch (_) {
    return { ok: false, fatal: true, error: `unparseable finalise response: ${body.slice(0, 200)}` };
  }

  const url = j.url || j.source_url || "(no url)";
  const expectedUrl = publicUrlFor(name);
  const ok = normaliseUrlPath(url) === normaliseUrlPath(expectedUrl);
  console.log(`  ${ok ? "✓" : "⚠"} ${name} → ${url}`);
  if (!ok) console.warn(`  (expected ${expectedUrl} — website upload endpoint may need updating)`);
  return { ok, url };
}

async function uploadOneMediaAttempt(filePath, name) {
  const buf = fs.readFileSync(filePath);

  const res = await fetchWithTimeout(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization":         auth,
      "Content-Type":          mimeFor(name),
      "Content-Disposition":   `attachment; filename="${name}"`,
      "X-WHE-Software-Upload": "1",
      "X-WHE-Software-Product": SOFTWARE_PRODUCT,
    },
    body: buf,
  });

  const body = await res.text();
  if (!res.ok) {
    const msg = extractErrorMessage(body);
    console.error(`✗ ${name}: HTTP ${res.status}\n   ${msg || "(empty body)"}`);
    return false;
  }

  try {
    const j = JSON.parse(body);
    const url = j.source_url || (j.guid && j.guid.rendered) || "(no url)";
    const expectedUrl = publicUrlFor(name);
    const ok  = normaliseUrlPath(url) === normaliseUrlPath(expectedUrl);
    console.log(`  ${ok ? "✓" : "⚠"} ${name} → ${url}`);
    if (!ok) console.warn(`  (expected ${expectedUrl} — upload router may not be active or theme needs updating)`);
    return { ok, url };
  } catch (_) {
    console.error(`✗ ${name}: unparseable response ${body.slice(0, 200)}`);
    return { ok: false, error: "unparseable response" };
  }
}

function extractErrorMessage(body) {
  const text = String(body || "");
  try {
    const parsed = JSON.parse(text);
    const parts = [];
    if (parsed && parsed.message) parts.push(String(parsed.message));
    const data = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : null;
    if (data) {
      if (data.expected !== undefined) parts.push(`expected ${data.expected}`);
      if (data.received !== undefined) parts.push(`received ${data.received}`);
      if (data.status !== undefined) parts.push(`status ${data.status}`);
    }
    if (parts.length) return parts.join(" — ");
  } catch (_) {}
  const jMatch = text.match(/"message"\s*:\s*"([^"]+)"/);
  if (jMatch) return jMatch[1];
  const errBlock = text.match(/id=["']error-page["'][^>]*>([\s\S]*?)<\/div>/i);
  const region = errBlock ? errBlock[1] : text;
  return region
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function normaliseUrlPath(value) {
  try {
    const url = new URL(String(value));
    return decodeURIComponent(url.pathname).replace(/\/+$/, "");
  } catch (_) {
    return String(value || "").replace(/\/+$/, "");
  }
}

async function uploadOne(filePath) {
  const name = path.basename(filePath);
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    try {
      const result = await uploadOneAttempt(filePath);
      if (result && result.ok) return result;
      const existingUrl = await verifyUploaded(name, 2);
      if (existingUrl) {
        console.log(`  ✓ ${name} already reachable → ${existingUrl}`);
        return { ok: true, url: existingUrl };
      }
      if (attempt === UPLOAD_RETRIES) return result || { ok: false, error: "upload failed" };
    } catch (err) {
      const message = err && err.cause && err.cause.code
        ? `${err.message} (${err.cause.code})`
        : (err && err.message ? err.message : String(err));
      console.warn(`⚠ ${name}: upload attempt ${attempt}/${UPLOAD_RETRIES} failed: ${message}`);
      const existingUrl = await verifyUploaded(name);
      if (existingUrl) {
        console.log(`  ✓ ${name} landed despite timeout → ${existingUrl}`);
        return { ok: true, url: existingUrl };
      }
      if (attempt === UPLOAD_RETRIES) return { ok: false, error: message };
    }
    const waitMs = Math.min(60000, 5000 * attempt);
    console.log(`  retrying ${name} in ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }
  return { ok: false, error: "upload failed" };
}

async function pruneOldReleases(uploadedManifest) {
  if (!PRUNE_OLD_RELEASES) return;
  const okUploads = uploadedManifest.filter(item => item && item.ok);
  const keepVersion = okUploads.map(item => versionFromFilename(item.name)).find(Boolean);
  if (!keepVersion) {
    console.warn("\n⚠ Could not determine uploaded version; skipping website release prune.");
    return;
  }

  try {
    const res = await fetchWithTimeout(PRUNE_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product: SOFTWARE_PRODUCT,
        keep_version: keepVersion,
        keep_files: okUploads.map(item => item.name),
      }),
    });
    const body = await res.text();
    if (res.status === 404 || res.status === 405) {
      console.warn("\n⚠ Website prune endpoint is not available; delete older iLive Monitor files manually.");
      return;
    }
    if (!res.ok) {
      console.warn(`\n⚠ Website prune failed: HTTP ${res.status} ${extractErrorMessage(body) || "(empty body)"}`);
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const deleted = Array.isArray(parsed.deleted) ? parsed.deleted.length : (Number.isFinite(parsed.deleted) ? parsed.deleted : 0);
    console.log(`\n✓ Website release prune complete. Kept ${keepVersion}; deleted ${deleted} older file(s).`);
  } catch (error) {
    console.warn(`\n⚠ Website prune failed: ${error.message || String(error)}`);
  }
}

(async () => {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error("Usage: node scripts/upload-to-site.js <file> [file ...]"); process.exit(1); }

  // Optional manifest path — when set, write a JSON array of
  // { name, ok, url, error } so the release-page generator can show
  // upload status alongside each artefact.
  const manifestPath = process.env.WHE_UPLOAD_MANIFEST || process.env.WESC_UPLOAD_MANIFEST || null;
  const manifest = [];

  let failures = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`✗ Not found: ${f}`);
      failures++;
      manifest.push({ name: path.basename(f), ok: false, error: "file not found" });
      continue;
    }
    const result = await uploadOne(f);
    const ok = !!(result && result.ok);
    if (!ok) failures++;
    manifest.push({
      name:  path.basename(f),
      ok,
      url:   (result && result.url)   || null,
      error: ok ? null : ((result && result.error) || `HTTP failure for ${path.basename(f)}`),
    });
  }

  if (manifestPath) {
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      console.log(`\n✓ Manifest written → ${manifestPath}`);
    } catch (e) {
      console.warn(`\n⚠ Could not write manifest to ${manifestPath}: ${e.message}`);
    }
  }

  if (failures > 0) { console.error(`\n✗ ${failures} upload(s) failed.`); process.exit(1); }
  await pruneOldReleases(manifest);
  console.log(`\n✓ Upload batch complete.`);
})();
