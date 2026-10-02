"use strict";
// Sign-in, roles and environment (reseller) isolation.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");

let t, admin;
test.before(async () => {
  t = await start();
  admin = t.client();
  assert.equal((await admin.login("admin@example.test", "admin-password-1")).status, 200);
});
test.after(() => t.stop());

test("sign-in: wrong password, missing CSRF token and cross-site requests are refused", async () => {
  const c = t.client();
  assert.equal((await c.login("admin@example.test", "wrong-password")).status, 401);
  // A session without the CSRF token cannot change anything.
  const ok = await c.login("admin@example.test", "admin-password-1");
  assert.equal(ok.status, 200);
  const res = await fetch(t.base + "/api/admin/tenants", {
    method: "POST",
    headers: { origin: t.base, "content-type": "application/json", cookie: c.cookie() },
    body: JSON.stringify({ name: "X" }),
  });
  assert.equal(res.status, 401);
  const cross = await c.call("POST", "/api/admin/tenants", { name: "X" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  // Locked out after 10 failures from the same address.
  const d = t.client();
  for (let i = 0; i < 10; i++) await d.login("nobody@example.test", "nope-nope-nope");
  assert.equal((await d.login("nobody@example.test", "nope-nope-nope")).status, 429);
});

test("roles: technician and content manager only get their own functions", async () => {
  const ev = (await admin.post("/api/admin/events", { title: "Rollen test" })).data;
  const lang = ev.languages[0].id,
    sess = ev.sessions[0].id;
  await admin.put(`/api/admin/sessions/${sess}/languages/${lang}/routes/primary`, {
    provider: "hls",
    config: { ingestUrl: "rtmp://in/live", streamKey: "very-secret", playbackUrl: "https://cdn.test/a.m3u8" },
  });
  for (const [email, role] of [
    ["tech@example.test", "technician"],
    ["content@example.test", "content"],
  ])
    assert.equal((await admin.post("/api/admin/users", { email, role, password: "password-1234" })).status, 200);
  const tech = t.client(),
    content = t.client();
  await tech.login("tech@example.test", "password-1234");
  await content.login("content@example.test", "password-1234");

  // Technician: streams and live yes, page/forms/users no.
  assert.equal((await tech.get("/api/admin/events/" + ev.event.id + "/live")).status, 200);
  assert.equal((await tech.put(`/api/admin/events/${ev.event.id}/pages/pre/${lang}`, { html: "<p>x</p>" })).status, 403);
  assert.equal((await tech.get("/api/admin/users")).status, 403);
  assert.equal((await tech.post("/api/admin/events/" + ev.event.id + "/status", { status: "test" })).status, 200);
  assert.equal((await tech.post("/api/admin/events/" + ev.event.id + "/status", { status: "archived" })).status, 403);

  // Content manager: page yes; streams, live control and stream secrets no.
  assert.equal((await content.put(`/api/admin/events/${ev.event.id}/pages/pre/${lang}`, { html: "<p>x</p>" })).status, 200);
  assert.equal((await content.get("/api/admin/events/" + ev.event.id + "/live")).status, 403);
  assert.equal((await content.post(`/api/admin/sessions/${sess}/languages/${lang}/switch`, { to: "backup", reason: "test" })).status, 403);
  const seen = (await content.get("/api/admin/events/" + ev.event.id)).data;
  assert.equal(seen.routes[0].streamKey, "");
  assert.equal(seen.routes[0].playbackUrl, "");
  assert.equal(seen.routes[0].configured, true);
  assert.ok(!JSON.stringify(seen).includes("very-secret"));
  // The technician sees the stream key; the audit log never contains it.
  const techView = (await tech.get("/api/admin/events/" + ev.event.id)).data;
  assert.equal(techView.routes[0].streamKey, "very-secret");
  const audit = (await admin.get("/api/admin/audit")).data;
  assert.ok(!JSON.stringify(audit).includes("very-secret"));

  // Disabling a user ends their session at once.
  const users = (await admin.get("/api/admin/users")).data;
  await admin.patch("/api/admin/users/" + users.find((u) => u.email === "tech@example.test").id, { active: false });
  assert.equal((await tech.get("/api/admin/events")).status, 401);
});

test("resellers only see their own environment", async () => {
  const reseller = (await admin.post("/api/admin/tenants", { name: "Reseller BV" })).data;
  assert.equal(
    (await admin.post("/api/admin/users", { email: "boss@reseller.test", role: "admin", password: "password-1234", tenantId: reseller.id })).status,
    200,
  );
  const platformCustomer = (await admin.post("/api/admin/customers", { name: "Platformklant" })).data;
  const platformEvent = (await admin.post("/api/admin/events", { title: "Platform event", customerId: platformCustomer.id })).data;

  const r = t.client();
  await r.login("boss@reseller.test", "password-1234");
  // Cannot create environments, cannot see platform data.
  assert.equal((await r.post("/api/admin/tenants", { name: "Sub" })).status, 403);
  assert.equal((await r.get("/api/admin/events/" + platformEvent.event.id)).status, 404);
  assert.equal((await r.get("/api/admin/customers/" + platformCustomer.id)).status, 404);
  assert.equal((await r.post("/api/admin/events", { title: "X", customerId: platformCustomer.id })).status, 404);
  assert.deepEqual((await r.get("/api/admin/customers")).data, []);
  assert.equal((await r.get("/api/admin/events")).data.length, 0);
  // A tenantId in the request is ignored for resellers: everything lands in their own environment.
  const own = (await r.post("/api/admin/customers", { name: "Eigen klant", tenantId: platformCustomer.tenantId })).data;
  assert.equal(own.tenantId, reseller.id);
  const ev = (await r.post("/api/admin/events", { title: "Reseller event", customerId: own.id })).data;
  assert.equal(ev.event.tenantId, reseller.id);
  assert.match(ev.event.reference, /^RESELL-\d{4}-0001$/);
  // Reseller sees only its own users and audit lines; the platform sees both.
  const users = (await r.get("/api/admin/users")).data;
  assert.ok(users.every((u) => u.tenantId === reseller.id));
  const audit = (await r.get("/api/admin/audit")).data;
  assert.ok(audit.length > 0 && audit.every((a) => a.tenant === "Reseller BV"));
  assert.ok((await admin.get("/api/admin/events")).data.some((e) => e.id === ev.event.id));
  // Blocking the environment signs the reseller out.
  await admin.patch("/api/admin/tenants/" + reseller.id, { status: "blocked" });
  assert.equal((await r.get("/api/admin/events")).status, 401);
  assert.equal((await r.login("boss@reseller.test", "password-1234")).status, 401);
});
