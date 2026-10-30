// MindVault Personal: local control plane and synthetic hosted demo.
// No framework; node:http keeps the dependency surface at zero.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { VaultStore } from "./src/store.js";
import { seedVault } from "./src/seed.js";
import { nebiusConfig, isConfigured } from "./src/nebius.js";
import { isValidTimeZone } from "./src/time.js";
import * as V from "./src/vault.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, ".env"));

const PROFILE = process.env.MINDVAULT_PROFILE === "hosted" ? "hosted" : "local";
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (PROFILE === "hosted" ? "0.0.0.0" : "127.0.0.1");
const TIMEZONE = isValidTimeZone(process.env.MINDVAULT_TIMEZONE || "") ? process.env.MINDVAULT_TIMEZONE : "Asia/Kolkata";
const CLOUD_ENABLED = process.env.MINDVAULT_CLOUD_ENABLED !== "false";
const DATA_DIR = process.env.MINDVAULT_DATA_DIR || path.join(ROOT, "data", PROFILE);
const SESSION_TTL_MS = 24 * 3600000;
const MAX_SESSIONS = 500;
const PER_SESSION_CALLS_PER_HOUR = Number(process.env.MINDVAULT_SESSION_CALLS_PER_HOUR || 12);
const GLOBAL_CALLS_PER_DAY = Number(process.env.MINDVAULT_GLOBAL_CALLS_PER_DAY || 400);

const cfg = nebiusConfig();
const store = new VaultStore(DATA_DIR);
const callLog = new Map(); // vaultId -> timestamps
let globalCalls = { day: "", count: 0 };

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---------- sessions and vault selection ----------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function vaultFor(req, res) {
  if (PROFILE === "local") {
    let v = store.get("local");
    if (!v) {
      v = seedVault(TIMEZONE);
      store.put("local", v);
    }
    return { id: "local", vault: v };
  }
  let sid = parseCookies(req).mv_session;
  let v = sid && /^s_[a-f0-9]{24}$/.test(sid) ? store.get(sid) : null;
  if (v && Date.now() - Date.parse(v.createdAt) > SESSION_TTL_MS) {
    store.remove(sid);
    v = null;
  }
  if (!v) {
    if (store.ids().length >= MAX_SESSIONS) sweepSessions(true);
    sid = `s_${crypto.randomBytes(12).toString("hex")}`;
    v = seedVault(TIMEZONE);
    store.put(sid, v);
    res.setHeader("Set-Cookie", `mv_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${process.env.MINDVAULT_INSECURE_COOKIE ? "" : "; Secure"}`);
  }
  return { id: sid, vault: v };
}

function sweepSessions(force = false) {
  const ids = store.ids();
  const rows = ids.map((id) => ({ id, v: store.get(id) })).filter((r) => r.v);
  rows.sort((a, b) => Date.parse(a.v.updatedAt || a.v.createdAt) - Date.parse(b.v.updatedAt || b.v.createdAt));
  for (const r of rows) {
    const expired = Date.now() - Date.parse(r.v.createdAt) > SESSION_TTL_MS;
    if (expired || (force && rows.length > MAX_SESSIONS * 0.8)) {
      store.remove(r.id);
      callLog.delete(r.id);
    }
  }
}

function checkInferenceBudget(vaultId) {
  if (PROFILE !== "hosted") return;
  const now = Date.now();
  const recent = (callLog.get(vaultId) || []).filter((t) => now - t < 3600000);
  if (recent.length >= PER_SESSION_CALLS_PER_HOUR) throw new V.HttpError(429, "This demo session reached its hourly limit for connected reasoning. Local planning still works.");
  const day = new Date().toISOString().slice(0, 10);
  if (globalCalls.day !== day) globalCalls = { day, count: 0 };
  if (globalCalls.count >= GLOBAL_CALLS_PER_DAY) throw new V.HttpError(429, "The demo reached today's shared limit for connected reasoning. Local planning still works.");
  recent.push(now);
  callLog.set(vaultId, recent);
  globalCalls.count += 1;
}

// ---------- request plumbing ----------

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new V.HttpError(413, "Request too large.");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new V.HttpError(400, "Invalid JSON.");
  }
}

function hostAllowed(req) {
  if (PROFILE === "hosted") return true;
  const host = (req.headers.host || "").toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(ROOT, "public", p));
  if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  fs.createReadStream(file).pipe(res);
}

function publicConfig() {
  return {
    profile: PROFILE,
    cloudConfigured: CLOUD_ENABLED && isConfigured(cfg),
    model: cfg.model || null,
    endpointHost: new URL(cfg.baseUrl).host,
    recipient: PROFILE === "hosted" ? "This demo server, then Nebius Token Factory" : "Your computer, then Nebius Token Factory",
  };
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[A-Za-z0-9_]+)")}$`), handler });

route("GET", "/api/state", ({ vault }) => V.snapshot(vault, { config: publicConfig() }));
route("POST", "/api/sources", ({ vault, body }) => V.createSource(vault, body));
route("PATCH", "/api/sources/:id", ({ vault, body, params }) => V.updateSource(vault, params.id, body));
route("POST", "/api/sources/:id/done", ({ vault, body, params }) => V.setSourceDone(vault, params.id, body.done !== false));
route("DELETE", "/api/sources/:id", ({ vault, params }) => V.deleteSource(vault, params.id));
route("POST", "/api/memories", ({ vault, body }) => V.createMemory(vault, body));
route("PATCH", "/api/memories/:id", ({ vault, body, params }) => V.correctMemory(vault, params.id, body));
route("DELETE", "/api/memories/:id", ({ vault, params }) => V.deleteMemory(vault, params.id));
route("POST", "/api/disclosures/preview", ({ vault, body }) => {
  if (!publicConfig().cloudConfigured) throw new V.HttpError(503, "Connected reasoning is not configured on this server. Use local planning, or set NEBIUS_API_KEY and NEBIUS_MODEL_ID.");
  const { disclosure, excluded } = V.previewDisclosure(vault, body);
  return { id: disclosure.id, digest: disclosure.digest, bytes: disclosure.bytes, messages: disclosure.messages, excluded, recipient: publicConfig().recipient, model: cfg.model };
});
route("POST", "/api/disclosures/:id/approve", async ({ vault, vaultId, body, params }) => {
  checkInferenceBudget(vaultId);
  return V.approveDisclosure(vault, params.id, body.digest, cfg);
});
route("POST", "/api/plans/local", ({ vault, body }) => V.localPlan(vault, body));
route("POST", "/api/plans/:id/rebuild", ({ vault, params }) => V.rebuildPlan(vault, params.id));
route("POST", "/api/plans/:id/commit", ({ vault, body, params }) => V.commitPlan(vault, params.id, body));
route("POST", "/api/jobs", ({ vault, body }) => V.createJob(vault, body));
route("POST", "/api/jobs/:id/pause", ({ vault, params }) => V.setJobStatus(vault, params.id, "paused"));
route("POST", "/api/jobs/:id/resume", ({ vault, params }) => V.setJobStatus(vault, params.id, "active"));
route("POST", "/api/notifications/read", ({ vault }) => {
  for (const n of vault.notifications) n.read = true;
  return { ok: true };
});
route("POST", "/api/vault/reset", ({ vault }) => {
  const fresh = seedVault(TIMEZONE);
  for (const k of Object.keys(vault)) delete vault[k];
  Object.assign(vault, fresh);
  V.log(vault, "vault.reset", {});
  return { ok: true };
});

async function handleApi(req, res) {
  const url = new URL(req.url, "http://x");
  const mutating = req.method !== "GET";
  // Mutations need a custom header, which a cross-site form cannot send.
  if (mutating && req.headers["x-mindvault"] !== "1") return send(res, 403, { error: "Missing request header." });
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const { id, vault } = vaultFor(req, res);
    const body = mutating ? await readJson(req) : {};
    const out = await r.handler({ vault, vaultId: id, body, params: m.groups || {} });
    if (mutating) store.put(id, vault);
    return send(res, 200, out);
  }
  send(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 421, { error: "Unexpected Host header." });
    if (req.url === "/healthz") return send(res, 200, { ok: true, profile: PROFILE, cloudConfigured: publicConfig().cloudConfigured });
    if (req.url.startsWith("/api/")) return await handleApi(req, res);
    if (req.method !== "GET") return send(res, 405, { error: "Method not allowed." });
    serveStatic(req, res);
  } catch (e) {
    const status = e instanceof V.HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    // Errors from failed sends may have mutated state (logged failure).
    try {
      if (req.url.startsWith("/api/")) {
        const sid = PROFILE === "local" ? "local" : parseCookies(req).mv_session;
        const v = sid && store.get(sid);
        if (v) store.put(sid, v);
      }
    } catch {}
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the server." : e.message });
  }
});

// Scheduler: delivers reminders and runs review_day jobs while the
// service is running. It does not run when the machine is off.
function schedulerPass() {
  const ids = PROFILE === "local" ? ["local"] : [...store.cache.keys()];
  for (const id of ids) {
    const v = store.get(id);
    if (!v) continue;
    try {
      if (V.tick(v)) store.put(id, v);
    } catch (e) {
      console.error("scheduler", id, e.message);
    }
  }
}

export function start() {
  if (PROFILE === "hosted") for (const id of store.ids()) store.get(id); // warm cache so jobs run
  setInterval(schedulerPass, 10000).unref();
  if (PROFILE === "hosted") setInterval(sweepSessions, 3600000).unref();
  server.listen(PORT, HOST, () => {
    const c = publicConfig();
    console.log(`MindVault (${PROFILE}) on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    console.log(c.cloudConfigured ? `Connected reasoning: ${c.model} via ${c.endpointHost}` : "Connected reasoning: not configured (local planning only)");
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
