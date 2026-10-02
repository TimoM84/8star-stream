"use strict";
// Staff sign-in, sessions, roles and environment (tenant) scoping.
//
// Roles:
//   admin       platform administrator (NFGD environment) or reseller
//               administrator (reseller environment)
//   technician  streams, Green Room, live control and phases
//   content     watch page, templates, media, registration forms,
//               registrations and VOD
// NFGD (the platform environment) sees every environment; a reseller only
// its own. Every lookup of a tenant-owned record goes through canSee().
const { token, verifySecret, sha256 } = require("./util");
const { fail, cookies, cookie } = require("./http");

const COOKIE = "s8s";
const SESSION_MS = 12 * 3600 * 1000;
const PERMISSIONS = {
  admin: [
    "customers",
    "users",
    "events.view",
    "events.edit",
    "streams",
    "live",
    "pages",
    "forms",
    "registrations",
    "vod",
    "usage",
    "audit",
  ],
  technician: ["events.view", "streams", "live"],
  content: ["events.view", "pages", "forms", "registrations", "vod"],
};

function createAuth(db, { trustProxy, secureCookies }) {
  const sessions = new Map(),
    failures = new Map();
  const tenantOf = db.prepare("SELECT * FROM tenants WHERE id = ?");
  const userBy = db.prepare("SELECT * FROM users WHERE id = ?");
  const userByEmail = db.prepare("SELECT * FROM users WHERE email = ?");

  const describe = (u) => {
    const t = tenantOf.get(u.tenant_id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      tenantId: u.tenant_id,
      tenantName: t?.name || "",
      platform: t?.kind === "platform",
      permissions: [
        ...PERMISSIONS[u.role],
        ...(t?.kind === "platform" && u.role === "admin" ? ["tenants", "settings", "templates.central"] : []),
      ],
    };
  };

  async function login(req, email, password, ip) {
    const key = sha256(String(email).toLowerCase() + "|" + ip),
      f = failures.get(key);
    if (f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000)
      fail(429, "Too many sign-in attempts. Please try again later.");
    const u = userByEmail.get(String(email || "").trim().toLowerCase());
    const t = u && tenantOf.get(u.tenant_id);
    const ok = u && u.active && t?.status === "active" && (await verifySecret(password, u.password));
    if (!ok) {
      const entry = f && Date.now() - f.first < 15 * 60 * 1000 ? f : { count: 0, first: Date.now() };
      entry.count++;
      failures.set(key, entry);
      fail(401, "Incorrect email address or password.");
    }
    failures.delete(key);
    const sid = token(),
      csrf = token(24);
    sessions.set(sid, { userId: u.id, csrf, expires: Date.now() + SESSION_MS });
    db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(new Date().toISOString(), u.id);
    return {
      user: describe(u),
      csrf,
      cookie: cookie(COOKIE, sid, { maxAge: SESSION_MS / 1000, secure: secureCookies(req), sameSite: "Strict" }),
    };
  }

  // The signed-in user, or null. State-changing requests also need the
  // session's CSRF token.
  function current(req, { mutating = false } = {}) {
    const sid = cookies(req)[COOKIE],
      s = sid && sessions.get(sid);
    if (!s || s.expires < Date.now()) {
      if (sid) sessions.delete(sid);
      return null;
    }
    if (mutating && req.headers["x-csrf-token"] !== s.csrf) return null;
    const u = userBy.get(s.userId);
    const t = u && tenantOf.get(u.tenant_id);
    if (!u || !u.active || t?.status !== "active") {
      sessions.delete(sid);
      return null;
    }
    return { ...describe(u), csrf: s.csrf, sid };
  }
  function logout(req) {
    const sid = cookies(req)[COOKIE];
    if (sid) sessions.delete(sid);
    return cookie(COOKIE, "", { maxAge: 0, sameSite: "Strict" });
  }
  // Ends every session of a user (password change, disabled account).
  function revoke(userId) {
    for (const [sid, s] of sessions) if (s.userId === userId) sessions.delete(sid);
  }
  function sweep() {
    const t = Date.now();
    for (const [sid, s] of sessions) if (s.expires < t) sessions.delete(sid);
    for (const [k, f] of failures) if (t - f.first > 15 * 60 * 1000) failures.delete(k);
  }
  setInterval(sweep, 60000).unref();
  return { login, current, logout, revoke, describe };
}

const can = (user, permission) => Boolean(user && user.permissions.includes(permission));
function need(user, permission) {
  if (!user) fail(401, "Please sign in.");
  if (permission && !can(user, permission)) fail(403, "You do not have permission for this action.");
}
// NFGD sees all environments; a reseller only its own.
const canSee = (user, tenantId) => Boolean(user && (user.platform || user.tenantId === tenantId));
// SQL fragment + parameter limiting a query to the user's environment.
const scope = (user, column = "tenant_id") =>
  user.platform ? { where: "1 = 1", params: [] } : { where: column + " = ?", params: [user.tenantId] };

module.exports = { createAuth, can, need, canSee, scope, PERMISSIONS };
