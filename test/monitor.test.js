"use strict";
// Signal detection on HLS playlists, usage minutes (live vs test), viewers
// and the usage export.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { start } = require("./helpers");
const { probe, forget } = require("../src/providers/probe");

// A tiny HLS origin whose playlists the test controls.
let origin, base;
const playlists = {};
test.before(async () => {
  origin = http.createServer((req, res) => {
    const body = playlists[req.url];
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(body);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + origin.address().port;
});
test.after(() => origin.close());

const media = (seq, end = false) =>
  ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:" + seq, "#EXTINF:2,", "seg" + seq + ".ts", "#EXTINF:2,", "seg" + (seq + 1) + ".ts", end ? "#EXT-X-ENDLIST" : ""].join("\n");

test("probe: ok while segments advance, lost when stalled, ended or unreachable", async () => {
  playlists["/live.m3u8"] = media(10);
  const t0 = Date.now();
  assert.equal((await probe("r1", base + "/live.m3u8", { now: t0 })).signal, "ok");
  // Same playlist 15 s later: still ok (threshold is max(20 s, 3 × target)).
  assert.equal((await probe("r1", base + "/live.m3u8", { now: t0 + 15000 })).signal, "ok");
  const stalled = await probe("r1", base + "/live.m3u8", { now: t0 + 25000 });
  assert.equal(stalled.signal, "lost");
  assert.match(stalled.detail, /No new video/);
  playlists["/live.m3u8"] = media(11);
  assert.equal((await probe("r1", base + "/live.m3u8", { now: t0 + 26000 })).signal, "ok");
  playlists["/live.m3u8"] = media(12, true);
  assert.equal((await probe("r1", base + "/live.m3u8", { now: t0 + 27000 })).detail, "Stream ended");
  assert.equal((await probe("r2", base + "/missing.m3u8")).detail, "HTTP 404");
  assert.equal((await probe("r3", "")).signal, "unknown");
  // Master playlist: the first variant is followed.
  playlists["/master.m3u8"] = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n";
  playlists["/variant.m3u8"] = media(1);
  assert.equal((await probe("r4", base + "/master.m3u8")).signal, "ok");
  forget("r1");
});

test("usage: live minutes only for the active route of a public live session; test minutes separate", async () => {
  const t = await start();
  try {
    const admin = t.client();
    await admin.login("admin@nfgd.test", "admin-password-1");
    let ev = (await admin.post("/api/admin/events", {
      title: "Gebruik",
      startAt: new Date(Date.now() - 3600e3).toISOString(),
      endAt: new Date(Date.now() + 3600e3).toISOString(),
    })).data;
    const sess = ev.sessions[0].id,
      nl = ev.languages[0].id;
    playlists["/a.m3u8"] = media(1);
    playlists["/b.m3u8"] = media(1);
    for (const [slot, path] of [["primary", "/a.m3u8"], ["backup", "/b.m3u8"]])
      await admin.put(`/api/admin/sessions/${sess}/languages/${nl}/routes/${slot}`, { provider: "hls", config: { playbackUrl: base + path }, bitrateKbps: 4000 });

    // Test status: both routes with signal count as test minutes.
    await admin.post("/api/admin/events/" + ev.event.id + "/status", { status: "test" });
    await t.app.monitor.probeAll();
    t.app.monitor.flushMinutes(true);
    // Scheduled and live: the active (primary) route counts as live, with viewers.
    await admin.post("/api/admin/events/" + ev.event.id + "/status", { status: "scheduled" });
    const viewer = t.client();
    for (const id of ["viewer-aaaaaaaa", "viewer-bbbbbbbb"])
      assert.equal((await viewer.post("/api/watch/" + ev.event.slug + "/beat", { viewer: id, session: sess, lang: "nl" })).status, 204);
    playlists["/a.m3u8"] = media(2);
    playlists["/b.m3u8"] = media(2);
    // Same minute as the test run is already stored (one row per route and
    // minute), so move the clock of the stored rows back one minute first.
    t.app.db.prepare("UPDATE usage_minutes SET minute = strftime('%Y-%m-%dT%H:%M:00.000Z', minute, '-1 minute')").run();
    await t.app.monitor.probeAll();
    t.app.monitor.flushMinutes(true);
    t.app.viewers.flush();

    const rows = t.app.db.prepare("SELECT slot, kind, viewers, gb_estimate FROM usage_minutes ORDER BY slot, kind").all();
    assert.deepEqual(
      rows.map((r) => [r.slot, r.kind, r.viewers]),
      [
        ["backup", "test", 0],
        ["backup", "test", 0],
        ["primary", "live", 2],
        ["primary", "test", 0],
      ],
    );
    // 2 viewers × 4000 kbps × 60 s = 0.06 GB.
    assert.equal(Math.round(rows.find((r) => r.kind === "live").gb_estimate * 1000) / 1000, 0.06);

    const live = (await admin.get("/api/admin/events/" + ev.event.id + "/live")).data;
    assert.equal(live.viewers, 2);
    const usage = (await admin.get("/api/admin/usage?event=" + ev.event.id)).data;
    assert.equal(usage.events[0].liveMinutes, 1);
    assert.equal(usage.events[0].testMinutes, 3);
    assert.equal(usage.events[0].peak, 2);
    assert.equal(usage.events[0].plays, 2);
    const xlsx = await admin.get("/api/admin/usage/export?format=xlsx&event=" + ev.event.id);
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get("content-disposition"), /GEBRUIK|NFGD-\d{4}-0001_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx/);

    // Signal loss of the active route raises the alarm in live control.
    playlists["/a.m3u8"] = media(2, true);
    await t.app.monitor.probeAll();
    const alarm = (await admin.get("/api/admin/events/" + ev.event.id + "/live")).data;
    assert.equal(alarm.alarm, true);
    assert.equal(alarm.sessions[0].languages[0].warning, "signal");
    const dash = (await admin.get("/api/admin/dashboard")).data;
    assert.equal(dash.warnings[0].active, true);
    assert.ok((await admin.get("/api/admin/audit?action=signal.lost")).data.length >= 1);
  } finally {
    await t.stop();
  }
});
