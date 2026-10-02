"use strict";
// Security headers, media uploads, templates and translations.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { start } = require("./helpers");

let t, admin;
test.before(async () => {
  t = await start({ frameAncestors: "https://www.klant.nl" });
  admin = t.client();
  await admin.login("admin@nfgd.test", "admin-password-1");
});
test.after(() => t.stop());

test("headers: admin not embeddable, watch page embeddable where allowed, chat and approved iframes framed", async () => {
  const ev = (await admin.post("/api/admin/events", { title: "Headers" })).data;
  await admin.patch("/api/admin/events/" + ev.event.id, { chatUrl: "https://chatonline.8star.nl/e/demo", modules: { chat: true } });
  const adminPage = await fetch(t.base + "/");
  assert.match(adminPage.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(adminPage.headers.get("x-frame-options"), "SAMEORIGIN");
  const watch = await fetch(t.base + "/w/" + ev.event.slug);
  const csp = watch.headers.get("content-security-policy");
  assert.match(csp, /frame-ancestors 'self' https:\/\/www\.klant\.nl/);
  assert.match(csp, /frame-src https:\/\/chatonline\.8star\.nl https:\/\/youtube-nocookie\.com/);
  assert.match(csp, /script-src 'self';/);
  assert.equal((await fetch(t.base + "/watch.html")).status, 404);
  assert.equal((await fetch(t.base + "/vendor/hls.min.js")).status, 200);
});

test("media: only real images are accepted and served safely", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const up = await admin.call("POST", "/api/admin/media", png, { "content-type": "image/png", "x-file-name": "logo.png" });
  assert.equal(up.status, 200);
  const res = await fetch(t.base + up.data.url);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
  const fake = await admin.call("POST", "/api/admin/media", Buffer.from("<svg onload=alert(1)>"), { "content-type": "image/png" });
  assert.equal(fake.status, 415);
  const svg = await admin.call("POST", "/api/admin/media", Buffer.from("<svg/>"), { "content-type": "image/svg+xml" });
  assert.equal(svg.status, 415);
});

test("templates: central only by the platform, checked like pages", async () => {
  assert.equal((await admin.post("/api/admin/templates", { name: "Basis", central: true, html: "<h2>{{event}}</h2>" })).status, 200);
  assert.equal((await admin.post("/api/admin/templates", { name: "Fout", html: "<script>x</script>" })).status, 422);
  const reseller = (await admin.post("/api/admin/tenants", { name: "R" })).data;
  await admin.post("/api/admin/users", { email: "c@r.test", role: "content", password: "password-1234", tenantId: reseller.id });
  const r = t.client();
  await r.login("c@r.test", "password-1234");
  const list = (await r.get("/api/admin/templates")).data;
  assert.equal(list.length, 1);
  assert.equal((await r.patch("/api/admin/templates/" + list[0].id, { name: "X" })).status, 403);
  assert.equal((await r.post("/api/admin/templates", { name: "Eigen", central: true, html: "<p>x</p>" })).status, 403);
  const own = await r.post("/api/admin/templates", { name: "Eigen", html: "<p>x</p>" });
  assert.equal(own.data.tenantId, reseller.id);
  assert.equal((await admin.get("/api/admin/templates")).data.length, 2);
});

test("translations are complete", () => {
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "check-i18n.js")], { stdio: "pipe" });
});
