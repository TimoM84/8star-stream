"use strict";
// Stream routes (primary and backup per session and language), signal
// checks, manual route switching and the live control overview.
const { fail } = require("../http");
const { can } = require("../auth");
const { id, now, cleanLine, clean, json } = require("../util");
const { providerOf, PROVIDERS } = require("../providers");
const { probe } = require("../providers/probe");
const { schedulePhase, publicPhase } = require("../phase");
const { routeOut } = require("./common");

const SLOTS = ["primary", "backup"];

module.exports = (r, app) => {
  const { db, load } = app;

  // Create or change a route.
  r.put(
    "/api/admin/sessions/:sid/languages/:lid/routes/:slot",
    (ctx) => {
      const { session: s, language: l, event: e } = load.sessionLanguage(ctx.user, ctx.params.sid, ctx.params.lid);
      const slot = ctx.params.slot;
      if (!SLOTS.includes(slot)) fail(400, "Invalid request.");
      const providerId = PROVIDERS[ctx.body.provider] ? ctx.body.provider : "hls";
      const provider = providerOf(providerId);
      const existing = db.prepare("SELECT * FROM routes WHERE session_id = ? AND language_id = ? AND slot = ?").get(s.id, l.id, slot);
      const before = json(existing?.config, {});
      const config = {};
      for (const f of provider.fields) {
        const v = cleanLine(ctx.body.config?.[f.key], 500);
        // A masked secret keeps its stored value.
        config[f.key] = f.secret && v === "••••••" ? before[f.key] || "" : v;
      }
      const d = provider.describe(config);
      if (d.playbackUrl && !/^https?:\/\//i.test(d.playbackUrl)) fail(400, "The playback URL must start with https:// or http://.");
      const bitrate = Math.min(50000, Math.max(100, Math.round(Number(ctx.body.bitrateKbps) || 3000)));
      const changedUrl = !existing || providerOf(existing.provider).describe(before).playbackUrl !== d.playbackUrl;
      if (existing)
        db.prepare(
          `UPDATE routes SET provider = ?, config = ?, bitrate_kbps = ?${changedUrl ? ", signal = 'unknown', signal_detail = '', signal_changed_at = NULL" : ""} WHERE id = ?`,
        ).run(providerId, JSON.stringify(config), bitrate, existing.id);
      else
        db.prepare("INSERT INTO routes (id, session_id, language_id, slot, provider, config, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          id(),
          s.id,
          l.id,
          slot,
          providerId,
          JSON.stringify(config),
          bitrate,
        );
      if (existing && changedUrl) app.monitor.forget(existing.id);
      // Secrets are never written to the audit log.
      const safe = Object.fromEntries(provider.fields.filter((f) => !f.secret).map((f) => [f.key, config[f.key]]));
      load.audit(ctx.user, e.tenant_id, existing ? "route.update" : "route.create", s.id, { language: l.code, slot, provider: providerId, ...safe, bitrateKbps: bitrate });
      return app.bundle(ctx, e);
    },
    { perm: "streams" },
  );
  r.delete(
    "/api/admin/routes/:id",
    (ctx) => {
      const { route: rt, event: e } = load.route(ctx.user, ctx.params.id);
      db.prepare("DELETE FROM routes WHERE id = ?").run(rt.id);
      app.monitor.forget(rt.id);
      load.audit(ctx.user, e.tenant_id, "route.delete", rt.session_id, { language: rt.language_id, slot: rt.slot });
      return app.bundle(ctx, e);
    },
    { perm: "streams" },
  );
  // Check one route now (the monitor checks routes of sessions on air).
  r.post(
    "/api/admin/routes/:id/check",
    async (ctx) => {
      const { route: rt } = load.route(ctx.user, ctx.params.id);
      const url = providerOf(rt.provider).describe(json(rt.config, {})).playbackUrl;
      const res = await probe(rt.id, url);
      const t = now();
      db.prepare(
        "UPDATE routes SET signal = ?, signal_detail = ?, signal_checked_at = ?, signal_changed_at = CASE WHEN signal != ? THEN ? ELSE signal_changed_at END WHERE id = ?",
      ).run(res.signal, res.detail, t, res.signal, t, rt.id);
      return routeOut(db.prepare("SELECT * FROM routes WHERE id = ?").get(rt.id), can(ctx.user, "streams"));
    },
    { perm: "streams" },
  );

  // Manual switch between primary and backup: confirmed in the browser,
  // with a reason, recorded in the switch log and the audit log.
  r.post(
    "/api/admin/sessions/:sid/languages/:lid/switch",
    (ctx) => {
      const { session: s, language: l, event: e } = load.sessionLanguage(ctx.user, ctx.params.sid, ctx.params.lid);
      const to = ctx.body.to,
        reason = clean(ctx.body.reason, 300);
      if (!SLOTS.includes(to)) fail(400, "Invalid request.");
      if (reason.length < 3) fail(400, "Enter a reason for the switch.");
      app.ensureVariants(e.id);
      const v = db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?").get(s.id, l.id);
      if (v.active_slot === to) fail(409, "This route is already active.");
      const target = db.prepare("SELECT * FROM routes WHERE session_id = ? AND language_id = ? AND slot = ?").get(s.id, l.id, to);
      if (!target || !providerOf(target.provider).describe(json(target.config, {})).playbackUrl) fail(400, "This route has no playback URL yet.");
      app.tx(() => {
        db.prepare("UPDATE variants SET active_slot = ? WHERE session_id = ? AND language_id = ?").run(to, s.id, l.id);
        db.prepare(
          "INSERT INTO route_switches (id, session_id, language_id, from_slot, to_slot, reason, user_id, user_email, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id(), s.id, l.id, v.active_slot, to, reason, ctx.user.id, ctx.user.email, now());
      });
      load.audit(ctx.user, e.tenant_id, "route.switch", s.id, {
        session: s.title,
        language: l.code,
        slot: [v.active_slot, to],
        reason,
        targetSignal: target.signal,
      });
      return live(ctx, e);
    },
    { perm: "live" },
  );

  // Live control and Green Room: phase, signal, active route, viewers.
  function live(ctx, e) {
    const t = Date.now();
    const languages = db.prepare("SELECT * FROM languages WHERE event_id = ? ORDER BY is_default DESC, sort, name").all(e.id);
    const sessions = db.prepare("SELECT * FROM sessions WHERE event_id = ? ORDER BY start_at, sort").all(e.id);
    const withSecrets = can(ctx.user, "streams");
    let alarm = false;
    const out = sessions.map((s) => {
      const phase = schedulePhase(s, e, t);
      return {
        id: s.id,
        title: s.title,
        room: s.room,
        startAt: s.start_at,
        endAt: s.end_at,
        phaseOverride: s.phase_override,
        phase,
        languages: languages.map((l) => {
          const v = db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?").get(s.id, l.id) || { active_slot: "primary" };
          const routes = {};
          for (const rt of db.prepare("SELECT * FROM routes WHERE session_id = ? AND language_id = ?").all(s.id, l.id))
            routes[rt.slot] = routeOut(rt, withSecrets);
          const pub = publicPhase(s, e, v, t);
          const active = routes[v.active_slot];
          // Alarm: the route viewers (would) see has no signal while on air.
          const onAir = l.active && (pub === "live" || e.status === "test");
          const lost = onAir && (!active || active.signal === "lost");
          if (lost && pub === "live") alarm = true;
          return {
            languageId: l.id,
            code: l.code,
            name: l.name,
            active: Boolean(l.active),
            isDefault: Boolean(l.is_default),
            phase: pub,
            activeSlot: v.active_slot,
            viewers: app.viewers.current(e.id, s.id, l.id),
            routes,
            warning: lost ? (active ? "signal" : "missing") : "",
          };
        }),
      };
    });
    const switches = db
      .prepare(
        `SELECT w.*, s.title AS session_title, l.name AS language FROM route_switches w
         JOIN sessions s ON s.id = w.session_id JOIN languages l ON l.id = w.language_id
         WHERE s.event_id = ? ORDER BY w.at DESC LIMIT 20`,
      )
      .all(e.id)
      .map((w) => ({ at: w.at, session: w.session_title, language: w.language, from: w.from_slot, to: w.to_slot, reason: w.reason, user: w.user_email }));
    return {
      now: new Date(t).toISOString(),
      status: e.status,
      alarm,
      viewers: app.viewers.current(e.id),
      sessions: out,
      switches,
    };
  }
  r.get("/api/admin/events/:id/live", (ctx) => live(ctx, load.event(ctx.user, ctx.params.id)), { perm: "live" });
};
