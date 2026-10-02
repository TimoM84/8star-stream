"use strict";
// The application: configuration, HTTP server, security headers, routing.
// server.js starts it; the tests create it with a temporary data folder.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { open, tx } = require("./db");
const { createAuth, need } = require("./auth");
const { HttpError, send, readJson, sameOrigin, isSecure, clientIp, staticFiles } = require("./http");
const { createRouter } = require("./router");
const { loaders } = require("./api/common");
const { createMonitor, createViewers } = require("./monitor");
const { id, now, hashSecret, token, json, isEmail } = require("./util");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const VERSION = require("../package.json").version;
const DEFAULT_IFRAME_HOSTS = ["youtube-nocookie.com", "youtube.com", "player.vimeo.com"];

function config(env = process.env) {
  const bool = (v, d) => (v === undefined || v === "" ? d : String(v).toLowerCase() === "true");
  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || path.join(__dirname, "..", "data"),
    adminEmail: String(env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || "",
    platformName: String(env.PLATFORM_NAME || "NFGD").trim() || "NFGD",
    publicUrl: String(env.PUBLIC_URL || "").replace(/\/+$/, ""),
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: String(env.COOKIE_SECURE || "auto").toLowerCase(),
    frameAncestors: env.FRAME_ANCESTORS || "*",
    probeSeconds: Math.max(2, Number(env.PROBE_SECONDS || 10)),
    monitor: bool(env.MONITOR, true),
    timeZone: env.TZ || "Europe/Amsterdam",
    maxUploadMb: Math.max(1, Number(env.MAX_UPLOAD_MB || 10)),
  };
}

async function createApp(options = {}) {
  const cfg = { ...config(options.env || process.env), ...options.config };
  const db = open(cfg.dataDir);
  fs.mkdirSync(path.join(cfg.dataDir, "media"), { recursive: true });

  // Settings stored in the database (secret for access grants, iframe hosts).
  const settings = {
    get: (key, fallback) => json(db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value, fallback),
    set: (key, value) =>
      db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(key, JSON.stringify(value)),
  };
  if (!settings.get("secret")) settings.set("secret", token(32));
  if (!settings.get("iframeHosts")) settings.set("iframeHosts", DEFAULT_IFRAME_HOSTS);

  await seed(db, cfg);

  const secureCookies = (req) =>
    cfg.cookieSecure === "true" || (cfg.cookieSecure !== "false" && isSecure(req, cfg.trustProxy));
  const auth = createAuth(db, { trustProxy: cfg.trustProxy, secureCookies });
  const viewers = createViewers(db);
  const load = loaders(db);
  const monitor = createMonitor(db, {
    viewers,
    probeSeconds: cfg.probeSeconds,
    onSignalChange: (r) => {
      if (r.previous === "unknown" && r.signal === "ok") return;
      load.audit(null, r.tenant_id, r.signal === "ok" ? "signal.restored" : "signal.lost", r.id, {
        session: r.session_id,
        language: r.language_id,
        slot: r.slot,
        detail: r.detail,
      });
    },
  });

  const publicUrl = (req) => cfg.publicUrl || (isSecure(req, cfg.trustProxy) ? "https://" : "http://") + host(req, cfg);
  const app = { db, cfg, auth, load, settings, viewers, monitor, tx: (fn) => tx(db, fn), publicUrl, version: VERSION };

  const router = createRouter();
  require("./api/org")(router, app);
  require("./api/events")(router, app);
  require("./api/streams")(router, app);
  require("./api/content")(router, app);
  require("./api/registration")(router, app);
  require("./api/reports")(router, app);
  const watch = require("./watch")(router, app);

  const assets = staticFiles(PUBLIC_DIR);
  const adminCsp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; " +
    "media-src 'self' blob: https: http:; connect-src 'self' https: http:; worker-src 'self' blob:; frame-src 'self' https:; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");

    if (p === "/health") return send(res, 200, { ok: true, version: VERSION });
    if (p.startsWith("/api/")) return api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
    if (p.startsWith("/media/")) return media(req, res, p.slice(7));
    const w = p.match(/^\/w\/([a-z0-9-]{1,64})\/?$/);
    if (w) return assets(req, res, "/watch.html", { "content-security-policy": watch.csp(w[1]) });
    if (p === "/" || p === "/index.html") return assets(req, res, "/admin.html", { "content-security-policy": adminCsp, "x-frame-options": "SAMEORIGIN" });
    if (!p.endsWith(".html") && assets(req, res, p, { "cache-control": "no-cache" })) return;
    send(res, 404, { error: "Not found." });
  }

  async function api(req, res, url) {
    const m = router.match(req.method, url.pathname);
    if (!m) return send(res, 404, { error: "Not found." });
    if (m.methodNotAllowed) return send(res, 405, { error: "Method not allowed." });
    const { route, params } = m;
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (mutating && !sameOrigin(req, cfg.trustProxy)) return send(res, 403, { error: "This request is not allowed." });
    const ctx = { req, res, url, params, query: url.searchParams, ip: clientIp(req, cfg.trustProxy), app, user: null, body: {} };
    if (route.opts.auth !== false) {
      ctx.user = auth.current(req, { mutating });
      need(ctx.user, route.opts.perm);
    } else if (route.opts.optionalAuth) ctx.user = auth.current(req);
    if (mutating && !route.opts.raw) ctx.body = await readJson(req);
    const out = await route.handler(ctx);
    // Changes in the admin reach the watch page at the next poll.
    if (mutating && route.opts.auth !== false) app.clearWatchCache?.();
    if (!res.headersSent && !res.writableEnded) {
      if (out === undefined) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
      } else send(res, 200, out);
    }
  }

  const mediaDir = path.join(cfg.dataDir, "media");
  function media(req, res, file) {
    if (!/^[a-z0-9]{16}\.(png|jpg|webp|gif)$/.test(file)) return send(res, 404, { error: "Not found." });
    const row = db.prepare("SELECT mime FROM media WHERE file = ?").get(file);
    const full = path.join(mediaDir, file);
    if (!row || !fs.existsSync(full)) return send(res, 404, { error: "Not found." });
    res.writeHead(200, {
      "content-type": row.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    });
    fs.createReadStream(full).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error(new Date().toISOString(), "error", req.method, req.url, e);
      send(res, 500, { error: "Something went wrong. Please try again." });
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  let started = false;
  app.listen = (port = cfg.port, hostname) =>
    new Promise((resolve) => {
      server.listen(port, hostname, () => {
        if (cfg.monitor && !started) {
          monitor.start();
          started = true;
        }
        resolve(server.address().port);
      });
    });
  app.close = () =>
    new Promise((resolve) => {
      monitor.stop();
      viewers.flush();
      server.closeAllConnections?.();
      server.close(() => {
        db.close();
        resolve();
      });
    });
  app.server = server;
  return app;
}

function host(req, cfg) {
  return String((cfg.trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "localhost")
    .split(",")[0]
    .trim();
}

// First start: the platform environment and its first administrator.
async function seed(db, cfg) {
  let platform = db.prepare("SELECT * FROM tenants WHERE kind = 'platform'").get();
  if (!platform) {
    platform = { id: id(), name: cfg.platformName };
    db.prepare("INSERT INTO tenants (id, name, kind, status, created_at) VALUES (?, ?, 'platform', 'active', ?)").run(
      platform.id,
      platform.name,
      now(),
    );
  }
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (users) return;
  if (!isEmail(cfg.adminEmail)) throw new Error("ADMIN_EMAIL is not a valid email address.");
  if (String(cfg.adminPassword).length < 12)
    throw new Error("Set ADMIN_PASSWORD (at least 12 characters) for the first administrator.");
  db.prepare(
    "INSERT INTO users (id, tenant_id, email, name, role, password, active, created_at) VALUES (?, ?, ?, ?, 'admin', ?, 1, ?)",
  ).run(id(), platform.id, cfg.adminEmail, "Administrator", await hashSecret(cfg.adminPassword), now());
}

module.exports = { createApp, config };
