"use strict";
// Test helpers: an app with a temporary data folder and a small HTTP client
// that keeps cookies and the CSRF token like the browser does.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");

async function start(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "8star-stream-test-"));
  const app = await createApp({
    env: { ADMIN_EMAIL: "admin@nfgd.test", ADMIN_PASSWORD: "admin-password-1", DATA_DIR: dataDir, MONITOR: "false" },
    config: { dataDir, monitor: false, ...config },
  });
  const port = await app.listen(0, "127.0.0.1");
  const base = "http://127.0.0.1:" + port;
  return {
    app,
    base,
    dataDir,
    client: () => client(base),
    async stop() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function client(base) {
  let cookie = "",
    csrf = "",
    access = "";
  async function call(method, url, body, headers = {}) {
    const h = { origin: base, ...headers };
    if (cookie) h.cookie = cookie;
    if (csrf) h["x-csrf-token"] = csrf;
    if (access) h["x-access"] = access;
    let payload = body;
    if (body !== undefined && !(body instanceof Buffer)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    call,
    get: (u, h) => call("GET", u, undefined, h),
    post: (u, b, h) => call("POST", u, b ?? {}, h),
    put: (u, b) => call("PUT", u, b ?? {}),
    patch: (u, b) => call("PATCH", u, b ?? {}),
    del: (u) => call("DELETE", u),
    async login(email, password) {
      const r = await call("POST", "/api/admin/login", { email, password });
      if (r.status === 200) csrf = r.data.csrf;
      return r;
    },
    setAccess: (t) => (access = t),
    cookie: () => cookie,
  };
}

module.exports = { start };
