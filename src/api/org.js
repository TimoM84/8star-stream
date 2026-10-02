"use strict";
// Sign-in, environments (resellers), customers, contacts, users, settings.
const { fail } = require("../http");
const { scope } = require("../auth");
const { id, now, hashSecret, verifySecret, cleanLine, isEmail, isHttpUrl, json } = require("../util");
const { catalog } = require("../providers");
const { diff } = require("./common");

const ROLES = ["admin", "technician", "content"];

// Branding: logo, colours, background image, page title.
function brandingIn(b = {}) {
  const color = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : "");
  const url = (v) => {
    const s = String(v || "").trim();
    return s.startsWith("/media/") || isHttpUrl(s) ? s.slice(0, 500) : "";
  };
  return {
    title: cleanLine(b.title, 120),
    logo: url(b.logo),
    background: url(b.background),
    primary: color(b.primary),
    backgroundColor: color(b.backgroundColor),
    text: color(b.text),
  };
}

module.exports = (r, app) => {
  const { db, auth, load, settings } = app;

  // ---- Sign-in -----------------------------------------------------------
  r.post(
    "/api/admin/login",
    async (ctx) => {
      const out = await auth.login(ctx.req, ctx.body.email, ctx.body.password, ctx.ip);
      load.audit(out.user, out.user.tenantId, "login", out.user.id);
      ctx.res.setHeader("set-cookie", out.cookie);
      return { user: out.user, csrf: out.csrf };
    },
    { auth: false },
  );
  r.post("/api/admin/logout", (ctx) => {
    ctx.res.setHeader("set-cookie", auth.logout(ctx.req));
    return { ok: true };
  });
  r.get("/api/admin/me", (ctx) => {
    const { csrf, sid, ...user } = ctx.user;
    return { user, csrf };
  });
  r.post("/api/admin/me/password", async (ctx) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.id);
    if (!(await verifySecret(ctx.body.current, u.password))) fail(400, "The current password is not correct.");
    const next = String(ctx.body.next || "");
    if (next.length < 12) fail(400, "Use at least 12 characters for the password.");
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(await hashSecret(next), u.id);
    auth.revoke(u.id);
    load.audit(ctx.user, ctx.user.tenantId, "user.password", u.id);
    ctx.res.setHeader("set-cookie", auth.logout(ctx.req));
    return { ok: true };
  });

  // Data the admin needs everywhere: providers, environments, settings.
  r.get("/api/admin/meta", (ctx) => ({
    version: app.version,
    providers: catalog(),
    publicUrl: app.publicUrl(ctx.req),
    iframeHosts: settings.get("iframeHosts", []),
    tenants: ctx.user.platform
      ? db.prepare("SELECT id, name, kind, status FROM tenants ORDER BY kind DESC, name").all()
      : db.prepare("SELECT id, name, kind, status FROM tenants WHERE id = ?").all(ctx.user.tenantId),
  }));

  // ---- Environments (only the platform) ----------------------------------
  r.get(
    "/api/admin/tenants",
    () =>
      db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS users,
                  (SELECT COUNT(*) FROM events e WHERE e.tenant_id = t.id) AS events,
                  (SELECT COUNT(*) FROM customers c WHERE c.tenant_id = t.id) AS customers
           FROM tenants t ORDER BY t.kind DESC, t.name`,
        )
        .all(),
    { perm: "tenants" },
  );
  r.post(
    "/api/admin/tenants",
    (ctx) => {
      const name = cleanLine(ctx.body.name, 120);
      if (!name) fail(400, "Enter a name.");
      const t = { id: id(), name };
      db.prepare("INSERT INTO tenants (id, name, kind, status, created_at) VALUES (?, ?, 'reseller', 'active', ?)").run(t.id, name, now());
      load.audit(ctx.user, t.id, "tenant.create", t.id, { name });
      return t;
    },
    { perm: "tenants" },
  );
  r.patch(
    "/api/admin/tenants/:id",
    (ctx) => {
      const t = load.tenant(ctx.user, ctx.params.id);
      const next = { name: ctx.body.name === undefined ? t.name : cleanLine(ctx.body.name, 120), status: ctx.body.status ?? t.status };
      if (!next.name) fail(400, "Enter a name.");
      if (!["active", "blocked", "archived"].includes(next.status)) fail(400, "Invalid request.");
      if (t.kind === "platform" && next.status !== "active") fail(400, "The platform environment cannot be blocked or archived.");
      db.prepare("UPDATE tenants SET name = ?, status = ? WHERE id = ?").run(next.name, next.status, t.id);
      if (next.status !== "active")
        for (const u of db.prepare("SELECT id FROM users WHERE tenant_id = ?").all(t.id)) auth.revoke(u.id);
      load.audit(ctx.user, t.id, "tenant.update", t.id, diff(t, next, ["name", "status"]));
      return { ...t, ...next };
    },
    { perm: "tenants" },
  );

  // ---- Customers and contacts -------------------------------------------
  const customerOut = (c) => ({
    id: c.id,
    tenantId: c.tenant_id,
    tenantName: c.tenant_name,
    name: c.name,
    accountManagerName: c.account_manager_name,
    accountManagerEmail: c.account_manager_email,
    branding: json(c.branding, {}),
    status: c.status,
    events: c.events,
    createdAt: c.created_at,
  });
  // Every user may list customers (the event form needs them).
  r.get("/api/admin/customers", (ctx) => {
    const s = scope(ctx.user, "c.tenant_id");
    return db
      .prepare(
        `SELECT c.*, t.name AS tenant_name, (SELECT COUNT(*) FROM events e WHERE e.customer_id = c.id) AS events
         FROM customers c JOIN tenants t ON t.id = c.tenant_id WHERE ${s.where} ORDER BY c.status, c.name`,
      )
      .all(...s.params)
      .map(customerOut);
  });
  r.get(
    "/api/admin/customers/:id",
    (ctx) => {
      const c = load.customer(ctx.user, ctx.params.id);
      const contacts = db.prepare("SELECT * FROM contacts WHERE customer_id = ? ORDER BY name").all(c.id);
      return { ...customerOut(c), contacts };
    },
    { perm: "customers" },
  );
  const customerFields = (b, c = {}) => {
    const out = {
      name: b.name === undefined ? c.name : cleanLine(b.name, 120),
      account_manager_name: b.accountManagerName === undefined ? c.account_manager_name : cleanLine(b.accountManagerName, 120),
      account_manager_email:
        b.accountManagerEmail === undefined ? c.account_manager_email : cleanLine(b.accountManagerEmail, 200).toLowerCase(),
      branding: b.branding === undefined ? c.branding : JSON.stringify(brandingIn(b.branding)),
      status: b.status === undefined ? c.status : b.status,
    };
    if (!out.name) fail(400, "Enter a name.");
    if (out.account_manager_email && !isEmail(out.account_manager_email)) fail(400, "Enter a valid email address.");
    if (!["active", "archived"].includes(out.status)) fail(400, "Invalid request.");
    return out;
  };
  r.post(
    "/api/admin/customers",
    (ctx) => {
      const f = customerFields(ctx.body, { status: "active", branding: "{}", account_manager_name: "", account_manager_email: "" });
      const c = { id: id(), tenant_id: load.targetTenant(ctx.user, ctx.body.tenantId), ...f, created_at: now() };
      db.prepare(
        "INSERT INTO customers (id, tenant_id, name, account_manager_name, account_manager_email, branding, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(c.id, c.tenant_id, c.name, c.account_manager_name, c.account_manager_email, c.branding, c.status, c.created_at);
      load.audit(ctx.user, c.tenant_id, "customer.create", c.id, { name: c.name });
      return customerOut(c);
    },
    { perm: "customers" },
  );
  r.patch(
    "/api/admin/customers/:id",
    (ctx) => {
      const c = load.customer(ctx.user, ctx.params.id);
      const f = customerFields(ctx.body, c);
      db.prepare(
        "UPDATE customers SET name = ?, account_manager_name = ?, account_manager_email = ?, branding = ?, status = ? WHERE id = ?",
      ).run(f.name, f.account_manager_name, f.account_manager_email, f.branding, f.status, c.id);
      load.audit(ctx.user, c.tenant_id, "customer.update", c.id, diff(c, f, Object.keys(f)));
      return customerOut({ ...c, ...f });
    },
    { perm: "customers" },
  );
  const contactFields = (b, c = {}) => {
    const pick = (k, max) => (b[k] === undefined ? c[k] ?? "" : cleanLine(b[k], max));
    const out = {
      name: pick("name", 120),
      function: pick("function", 120),
      email: pick("email", 200).toLowerCase(),
      phone: pick("phone", 40),
      language: pick("language", 10).toLowerCase() || "nl",
    };
    if (!out.name) fail(400, "Enter a name.");
    if (!isEmail(out.email)) fail(400, "Enter a valid email address.");
    return out;
  };
  r.post(
    "/api/admin/customers/:id/contacts",
    (ctx) => {
      const c = load.customer(ctx.user, ctx.params.id);
      const f = { id: id(), customer_id: c.id, ...contactFields(ctx.body) };
      db.prepare("INSERT INTO contacts (id, customer_id, name, function, email, phone, language) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        f.id,
        f.customer_id,
        f.name,
        f.function,
        f.email,
        f.phone,
        f.language,
      );
      load.audit(ctx.user, c.tenant_id, "contact.create", f.id, { customer: c.id, name: f.name });
      return f;
    },
    { perm: "customers" },
  );
  r.patch(
    "/api/admin/contacts/:id",
    (ctx) => {
      const { contact, customer } = load.contact(ctx.user, ctx.params.id);
      const f = contactFields(ctx.body, contact);
      db.prepare("UPDATE contacts SET name = ?, function = ?, email = ?, phone = ?, language = ? WHERE id = ?").run(
        f.name,
        f.function,
        f.email,
        f.phone,
        f.language,
        contact.id,
      );
      load.audit(ctx.user, customer.tenant_id, "contact.update", contact.id, diff(contact, f, Object.keys(f)));
      return { ...contact, ...f };
    },
    { perm: "customers" },
  );
  r.delete(
    "/api/admin/contacts/:id",
    (ctx) => {
      const { contact, customer } = load.contact(ctx.user, ctx.params.id);
      db.prepare("DELETE FROM contacts WHERE id = ?").run(contact.id);
      load.audit(ctx.user, customer.tenant_id, "contact.delete", contact.id, { name: contact.name, email: contact.email });
    },
    { perm: "customers" },
  );

  // ---- Users -------------------------------------------------------------
  const userOut = (u) => ({
    id: u.id,
    tenantId: u.tenant_id,
    tenantName: u.tenant_name,
    email: u.email,
    name: u.name,
    role: u.role,
    active: Boolean(u.active),
    createdAt: u.created_at,
    lastLogin: u.last_login,
  });
  r.get(
    "/api/admin/users",
    (ctx) => {
      const s = scope(ctx.user, "u.tenant_id");
      return db
        .prepare(`SELECT u.*, t.name AS tenant_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE ${s.where} ORDER BY t.kind DESC, t.name, u.email`)
        .all(...s.params)
        .map(userOut);
    },
    { perm: "users" },
  );
  r.post(
    "/api/admin/users",
    async (ctx) => {
      const email = cleanLine(ctx.body.email, 200).toLowerCase();
      if (!isEmail(email)) fail(400, "Enter a valid email address.");
      if (!ROLES.includes(ctx.body.role)) fail(400, "Choose a role.");
      if (String(ctx.body.password || "").length < 12) fail(400, "Use at least 12 characters for the password.");
      if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) fail(409, "This email address is already in use.");
      const u = {
        id: id(),
        tenant_id: load.targetTenant(ctx.user, ctx.body.tenantId),
        email,
        name: cleanLine(ctx.body.name, 120),
        role: ctx.body.role,
        created_at: now(),
        active: 1,
      };
      db.prepare("INSERT INTO users (id, tenant_id, email, name, role, password, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)").run(
        u.id,
        u.tenant_id,
        u.email,
        u.name,
        u.role,
        await hashSecret(ctx.body.password),
        u.created_at,
      );
      load.audit(ctx.user, u.tenant_id, "user.create", u.id, { email, role: u.role });
      return userOut(u);
    },
    { perm: "users" },
  );
  r.patch(
    "/api/admin/users/:id",
    async (ctx) => {
      const u = load.user(ctx.user, ctx.params.id);
      const next = {
        name: ctx.body.name === undefined ? u.name : cleanLine(ctx.body.name, 120),
        role: ctx.body.role ?? u.role,
        active: ctx.body.active === undefined ? u.active : ctx.body.active ? 1 : 0,
      };
      if (!ROLES.includes(next.role)) fail(400, "Choose a role.");
      if (u.id === ctx.user.id && (next.role !== "admin" || !next.active))
        fail(400, "You cannot remove your own administrator rights or disable your own account.");
      db.prepare("UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?").run(next.name, next.role, next.active, u.id);
      const changes = diff(u, next, ["name", "role", "active"]);
      if (ctx.body.password) {
        if (String(ctx.body.password).length < 12) fail(400, "Use at least 12 characters for the password.");
        db.prepare("UPDATE users SET password = ? WHERE id = ?").run(await hashSecret(ctx.body.password), u.id);
        changes.password = ["", "changed"];
      }
      if (!next.active || next.role !== u.role || ctx.body.password) auth.revoke(u.id);
      load.audit(ctx.user, u.tenant_id, "user.update", u.id, changes);
      return userOut({ ...u, ...next });
    },
    { perm: "users" },
  );

  // ---- Platform settings -------------------------------------------------
  r.get("/api/admin/settings", () => ({ iframeHosts: settings.get("iframeHosts", []) }), { perm: "settings" });
  r.put(
    "/api/admin/settings",
    (ctx) => {
      const before = settings.get("iframeHosts", []);
      const hosts = [
        ...new Set(
          (Array.isArray(ctx.body.iframeHosts) ? ctx.body.iframeHosts : [])
            .map((h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
            .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)),
        ),
      ].slice(0, 50);
      settings.set("iframeHosts", hosts);
      load.audit(ctx.user, ctx.user.tenantId, "settings.update", "iframeHosts", { iframeHosts: [before, hosts] });
      return { iframeHosts: hosts };
    },
    { perm: "settings" },
  );
};

module.exports.brandingIn = brandingIn;
