"use strict";
// HTTP helpers: JSON answers, request bodies, cookies, origin checks and
// static files with ETags and compression.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Request too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const v = JSON.parse(raw.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, { maxAge, path: p = "/", secure, sameSite = "Lax", httpOnly = true } = {}) {
  return (
    name +
    "=" +
    encodeURIComponent(value) +
    "; Path=" +
    p +
    (httpOnly ? "; HttpOnly" : "") +
    "; SameSite=" +
    sameSite +
    (secure ? "; Secure" : "") +
    (maxAge !== undefined ? "; Max-Age=" + maxAge : "")
  );
}

// State-changing requests must come from this site (checked with Origin,
// falling back to Referer; Sec-Fetch-Site "cross-site" is always refused).
function sameOrigin(req, trustProxy) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const host = String((trustProxy && req.headers["x-forwarded-host"]) || req.headers.host || "")
    .split(",")[0]
    .trim();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
const isSecure = (req, trustProxy) =>
  Boolean(req.socket.encrypted) ||
  (trustProxy && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
const clientIp = (req, trustProxy) =>
  (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) ||
  req.socket.remoteAddress ||
  "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};
// Static files are read once and kept in memory with an ETag and
// pre-compressed variants.
function staticFiles(dir) {
  const cache = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const body = fs.readFileSync(full),
          type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
          text = /^(text|application\/json|image\/svg)/.test(type);
        cache.set("/" + path.relative(dir, full).split(path.sep).join("/"), {
          body,
          type,
          etag: '"' + crypto.createHash("sha1").update(body).digest("base64url").slice(0, 20) + '"',
          gzip: text ? zlib.gzipSync(body) : null,
          br: text ? zlib.brotliCompressSync(body) : null,
        });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return (req, res, file, headers = {}) => {
    const a = cache.get(file);
    if (!a) return false;
    const h = { "content-type": a.type, etag: a.etag, "cache-control": "no-cache", vary: "accept-encoding", ...headers };
    if (req.headers["if-none-match"] === a.etag) {
      res.writeHead(304, h);
      res.end();
      return true;
    }
    const enc = String(req.headers["accept-encoding"] || "");
    if (a.br && /\bbr\b/.test(enc)) {
      res.writeHead(200, { ...h, "content-encoding": "br" });
      res.end(a.br);
    } else if (a.gzip && /\bgzip\b/.test(enc)) {
      res.writeHead(200, { ...h, "content-encoding": "gzip" });
      res.end(a.gzip);
    } else {
      res.writeHead(200, h);
      res.end(a.body);
    }
    return true;
  };
}

module.exports = { HttpError, fail, send, readBody, readJson, cookies, cookie, sameOrigin, isSecure, clientIp, staticFiles, MIME };
