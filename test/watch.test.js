"use strict";
// The public watch link: phases, test streams, route switches, languages,
// access codes, registration and page content.
const test = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./helpers");
const { schedulePhase, publicPhase } = require("../src/phase");

let t, admin, ev, nl, en, sess;
const state = (c, q = "") => c.get("/api/watch/" + ev.event.slug + "/state" + q).then((r) => r.data);
test.before(async () => {
  t = await start();
  admin = t.client();
  await admin.login("admin@example.test", "admin-password-1");
  ev = (await admin.post("/api/admin/events", { title: "Kijk test", startAt: new Date(Date.now() - 3600e3).toISOString(), endAt: new Date(Date.now() + 3600e3).toISOString() })).data;
  nl = ev.languages[0].id;
  sess = ev.sessions[0].id;
  ev = (await admin.post("/api/admin/events/" + ev.event.id + "/languages", { code: "en", name: "English", copyFrom: nl })).data;
  en = ev.languages.find((l) => l.code === "en").id;
  const route = (lang, slot, url) =>
    admin.put(`/api/admin/sessions/${sess}/languages/${lang}/routes/${slot}`, { provider: "hls", config: { playbackUrl: url } });
  await route(nl, "primary", "https://cdn.test/nl-a.m3u8");
  await route(nl, "backup", "https://cdn.test/nl-b.m3u8");
  await route(en, "primary", "https://cdn.test/en-a.m3u8");
});
test.after(() => t.stop());

test("phase rules", () => {
  const s = { start_at: "2026-01-01T10:00:00Z", end_at: "2026-01-01T12:00:00Z", phase_override: null };
  const at = (h) => Date.parse("2026-01-01T" + h + ":00:00Z");
  assert.equal(schedulePhase(s, { status: "scheduled" }, at("09")), "pre");
  assert.equal(schedulePhase(s, { status: "scheduled" }, at("11")), "live");
  assert.equal(schedulePhase(s, { status: "scheduled" }, at("13")), "after");
  assert.equal(schedulePhase(s, { status: "test" }, at("11")), "pre");
  assert.equal(schedulePhase(s, { status: "draft" }, at("11")), "pre");
  assert.equal(schedulePhase({ ...s, phase_override: "live" }, { status: "scheduled" }, at("09")), "live");
  assert.equal(schedulePhase({ ...s, phase_override: "live" }, { status: "archived" }, at("11")), "after");
  const vod = (o) => ({ vod: JSON.stringify({ url: "https://v.test/x.mp4", published: true, ...o }) });
  assert.equal(publicPhase(s, { status: "scheduled" }, vod({ unlimited: true }), at("13")), "vod");
  assert.equal(publicPhase(s, { status: "scheduled" }, vod({ published: false, unlimited: true }), at("13")), "after");
  assert.equal(publicPhase(s, { status: "scheduled" }, vod({ expireAt: "2026-01-01T12:30:00Z" }), at("13")), "after");
  assert.equal(publicPhase(s, { status: "scheduled" }, vod({ publishAt: "2026-01-02T00:00:00Z", unlimited: true }), at("13")), "after");
});

test("a test stream is never given to viewers; live gives the active route", async () => {
  const viewer = t.client();
  await admin.post("/api/admin/events/" + ev.event.id + "/status", { status: "test" });
  let s = await state(viewer);
  assert.equal(s.phase, "pre");
  assert.equal(s.stream, null);
  assert.ok(!JSON.stringify(s).includes("cdn.test"));

  await admin.post("/api/admin/events/" + ev.event.id + "/status", { status: "scheduled" });
  s = await state(viewer, "?lang=nl&x=1");
  assert.equal(s.phase, "live");
  assert.equal(s.stream.url, "https://cdn.test/nl-a.m3u8");

  // Language choice (and an inactive language falls back to the default).
  assert.equal((await state(viewer, "?lang=en&x=2")).languageUnavailable, true);
  await admin.patch("/api/admin/languages/" + en, { active: true });
  s = await state(viewer, "?lang=en&x=3");
  assert.equal(s.language, "en");
  assert.equal(s.stream.url, "https://cdn.test/en-a.m3u8");

  // Route switch: needs a reason, is logged, and reaches viewers.
  const bad = await admin.post(`/api/admin/sessions/${sess}/languages/${nl}/switch`, { to: "backup", reason: "" });
  assert.equal(bad.status, 400);
  const sw = await admin.post(`/api/admin/sessions/${sess}/languages/${nl}/switch`, { to: "backup", reason: "Geen beeld primair" });
  assert.equal(sw.status, 200);
  assert.equal(sw.data.switches[0].reason, "Geen beeld primair");
  assert.equal((await admin.post(`/api/admin/sessions/${sess}/languages/${en}/switch`, { to: "backup", reason: "test" })).status, 400);
  t.app.clearWatchCache();
  s = await state(viewer, "?lang=nl&x=4");
  assert.equal(s.stream.url, "https://cdn.test/nl-b.m3u8");
  const audit = (await admin.get("/api/admin/audit?action=route.switch")).data;
  assert.equal(audit[0].detail.reason, "Geen beeld primair");
  assert.deepEqual(audit[0].detail.slot, ["primary", "backup"]);

  // Manual phase: after → the VOD once published.
  await admin.post("/api/admin/sessions/" + sess + "/phase", { phase: "after" });
  t.app.clearWatchCache();
  assert.equal((await state(viewer, "?lang=nl&x=5")).phase, "after");
  const noExpiry = await admin.put(`/api/admin/sessions/${sess}/languages/${nl}/vod`, { url: "https://v.test/rec.mp4", chapters: [{ title: "Start", time: "1:05" }] });
  assert.equal(noExpiry.status, 200);
  assert.equal((await admin.post(`/api/admin/sessions/${sess}/languages/${nl}/vod/publish`, { published: true })).status, 400);
  await admin.put(`/api/admin/sessions/${sess}/languages/${nl}/vod`, { url: "https://v.test/rec.mp4", unlimited: true, unlimitedReason: "Archief", trimStart: 5, chapters: [{ title: "Start", time: "1:05" }], subtitles: [{ lang: "en", label: "English", vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello" }] });
  assert.equal((await admin.post(`/api/admin/sessions/${sess}/languages/${nl}/vod/publish`, { published: true })).status, 200);
  t.app.clearWatchCache();
  s = await state(viewer, "?lang=nl&x=6");
  assert.equal(s.phase, "vod");
  assert.deepEqual(s.vod.chapters, [{ title: "Start", time: 65 }]);
  assert.equal(s.vod.trimStart, 5);
  // Subtitles: listed for viewers without their text, text served separately.
  assert.equal(s.vod.subtitles.length, 1);
  assert.equal(s.vod.subtitles[0].vtt, undefined);
  const sub = await viewer.get(s.vod.subtitles[0].url);
  assert.equal(sub.status, 200);
  assert.match(sub.headers.get("content-type"), /text\/vtt/);
  assert.match(sub.data.toString(), /Hello/);
  assert.equal((await viewer.get(s.vod.subtitles[0].url.replace(/id=.*/, "id=nope"))).status, 404);
  const track = (await admin.get("/api/admin/events/" + ev.event.id)).data.variants.find((v) => v.sessionId === sess && v.languageId === nl).vod.subtitles[0];
  assert.equal(track.vtt, undefined);
  assert.ok(track.size > 10);
  // Changing only the label keeps the text; bad input is refused.
  const vodUrl = `/api/admin/sessions/${sess}/languages/${nl}/vod`;
  const keep = { url: "https://v.test/rec.mp4", unlimited: true, unlimitedReason: "Archief", trimStart: 5 };
  assert.equal((await admin.put(vodUrl, { ...keep, subtitles: [{ id: track.id, lang: "en", label: "Engels" }] })).status, 200);
  t.app.clearWatchCache();
  assert.match((await viewer.get(s.vod.subtitles[0].url)).data.toString(), /Hello/);
  assert.equal((await admin.put(vodUrl, { ...keep, subtitles: [{ lang: "en", label: "x", vtt: "not vtt" }] })).status, 400);
  assert.equal((await admin.put(vodUrl, { ...keep, subtitles: [{ lang: "English!", label: "x", vtt: "WEBVTT\n" }] })).status, 400);
  assert.equal((await admin.put(vodUrl, { ...keep, subtitles: [{ lang: "en", label: "x" }] })).status, 400);
  // A changed recording must be approved again.
  const changed = (await admin.put(`/api/admin/sessions/${sess}/languages/${nl}/vod`, { url: "https://v.test/rec2.mp4", unlimited: true, unlimitedReason: "Archief" })).data;
  assert.equal(changed.variants.find((v) => v.sessionId === sess && v.languageId === nl).vod.published, false);
  await admin.post("/api/admin/sessions/" + sess + "/phase", { phase: null });
});

test("page content: unsafe HTML refused, draft separate from published, variables filled", async () => {
  const url = `/api/admin/events/${ev.event.id}/pages/pre/${nl}`;
  const bad = await admin.put(url, { html: '<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="https://evil.example/"></iframe>' });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.problems.length, 4);
  assert.equal((await admin.put(url, { html: '<iframe src="https://www.youtube-nocookie.com/embed/x"></iframe>' })).status, 200);
  await admin.put(url, { html: "<p>Welkom bij {{event}} in {{language}}. [{{room}}] [{{onbekend}}] <a href='{{watchUrl}}'>link</a></p>" });
  await admin.post("/api/admin/events/" + ev.event.id + "/status", { status: "test" });
  const viewer = t.client();
  t.app.clearWatchCache();
  assert.equal((await state(viewer, "?lang=nl&p=1")).html, "");
  await admin.post(url + "/publish");
  t.app.clearWatchCache();
  const html = (await state(viewer, "?lang=nl&p=2")).html;
  assert.match(html, /Welkom bij Kijk test in Nederlands\. \[\] \[\]/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:\d+\/w\/kijk-test"/);
  // Draft preview is for signed-in staff only.
  assert.equal((await viewer.get("/api/watch/" + ev.event.slug + "/state?preview=1")).status, 401);
  assert.equal((await admin.get("/api/watch/" + ev.event.slug + "/state?preview=1&phase=after&lang=nl")).data.phase, "after");
});

test("access code", async () => {
  await admin.post("/api/admin/events/" + ev.event.id + "/status", { status: "scheduled" });
  assert.equal((await admin.patch("/api/admin/events/" + ev.event.id, { access: "code" })).status, 400);
  await admin.patch("/api/admin/events/" + ev.event.id, { access: "code", accessCode: "delft2026" });
  const viewer = t.client();
  let s = await state(viewer, "?lang=nl&c=1");
  assert.equal(s.access.granted, false);
  assert.equal(s.stream, null);
  assert.equal((await viewer.post("/api/watch/" + ev.event.slug + "/code", { code: "fout" })).status, 403);
  const ok = await viewer.post("/api/watch/" + ev.event.slug + "/code", { code: "delft2026" });
  viewer.setAccess(ok.data.token);
  s = await state(viewer, "?lang=nl&c=2");
  assert.equal(s.access.granted, true);
  assert.ok(s.stream.url);
  // A new code invalidates earlier grants.
  await admin.patch("/api/admin/events/" + ev.event.id, { accessCode: "nieuw2026" });
  assert.equal((await state(viewer, "?lang=nl&c=3")).access.granted, false);
});

test("registration: validation, consent record, approval gives access, exports", async () => {
  const fields = [
    { type: "text", label: "Naam", required: true },
    { type: "email", label: "E-mail", required: true },
    { type: "select", label: "Rol", required: true, options: [{ label: "Pers" }, { label: "Gast" }], translations: { en: { label: "Role" } } },
    { type: "consent", label: "Ik geef toestemming.", required: true, translations: { en: { label: "I consent." } } },
  ];
  await admin.patch("/api/admin/events/" + ev.event.id, { access: "registration" });
  const form = (await admin.put("/api/admin/events/" + ev.event.id + "/form", { enabled: true, approval: true, fields, texts: { nl: { pending: "Even geduld." } } })).data;
  const [naam, mail, rol, ok] = form.fields.map((f) => f.id);
  const viewer = t.client();
  let s = await state(viewer, "?lang=en&r=1");
  assert.equal(s.form.required, true);
  assert.equal(s.form.fields.find((f) => f.id === rol).label, "Role");
  const url = "/api/watch/" + ev.event.slug + "/register";
  const invalid = await viewer.post(url, { language: "en", answers: { [mail]: "geen-mail", [rol]: "bestaat-niet" } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(Object.keys(invalid.data.errors).sort(), [naam, mail, rol, ok].sort());
  // Honeypot: looks accepted, nothing stored.
  await viewer.post(url, { language: "en", website: "http://spam", answers: {} });
  const reg = await viewer.post(url, { language: "en", answers: { [naam]: "Anna", [mail]: "Anna@Example.org", [rol]: form.fields[2].options[1].id, [ok]: true } });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.status, "pending");
  viewer.setAccess(reg.data.token);
  s = await state(viewer, "?lang=en&r=2");
  assert.equal(s.access.status, "pending");
  assert.equal(s.access.granted, false);
  assert.equal(s.form, null);

  const list = (await admin.get("/api/admin/events/" + ev.event.id + "/registrations")).data;
  assert.equal(list.total, 1);
  const row = list.rows[0];
  assert.equal(row.email, "anna@example.org");
  assert.equal(row.answers[rol], "Gast");
  assert.equal(row.consent[0].text, "I consent.");
  assert.ok(row.consent[0].at);
  await admin.patch("/api/admin/registrations/" + row.id, { status: "approved" });
  t.app.clearWatchCache();
  s = await state(viewer, "?lang=en&r=3");
  assert.equal(s.access.granted, true);

  // Changing the form keeps old registrations readable.
  await admin.put("/api/admin/events/" + ev.event.id + "/form", { fields: [fields[0], fields[1]].map((f, i) => ({ ...f, id: form.fields[i].id })) });
  const after = (await admin.get("/api/admin/events/" + ev.event.id + "/registrations?q=gast")).data;
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].answers[rol], "Gast");
  assert.ok(after.fields.find((f) => f.id === rol).removed);

  const csv = await admin.get("/api/admin/events/" + ev.event.id + "/registrations/export?format=csv&lang=nl&name=mijn%20export");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition"), /filename="mijn_export\.csv"/);
  const text = csv.data.toString("utf8");
  assert.match(text, /"Goedgekeurd"/);
  assert.match(text, /"Gast"/);
  const xlsx = await admin.get("/api/admin/events/" + ev.event.id + "/registrations/export?format=xlsx");
  assert.equal(xlsx.data.subarray(0, 2).toString(), "PK");
});

test("copying an event and a language", async () => {
  const copy = (await admin.post("/api/admin/events/" + ev.event.id + "/copy", { title: "Kijk test 2027", shiftDays: 365 })).data;
  assert.notEqual(copy.event.slug, ev.event.slug);
  assert.equal(copy.event.status, "draft");
  assert.equal(copy.languages.length, 2);
  assert.equal(copy.routes.length, 3);
  assert.equal(Date.parse(copy.sessions[0].startAt) - Date.parse((await admin.get("/api/admin/events/" + ev.event.id)).data.sessions[0].startAt), 365 * 864e5);
  assert.equal((await admin.get("/api/admin/events/" + copy.event.id + "/registrations")).data.total, 0);
  // Copied language: inactive, page as draft only.
  const de = (await admin.post("/api/admin/events/" + ev.event.id + "/languages", { code: "de", name: "Deutsch", copyFrom: nl })).data;
  const lang = de.languages.find((l) => l.code === "de");
  assert.equal(lang.active, false);
  const pages = (await admin.get("/api/admin/events/" + ev.event.id + "/pages")).data.filter((p) => p.languageId === lang.id);
  assert.ok(pages.length && pages.every((p) => p.draftHtml && !p.publishedHtml));
});
