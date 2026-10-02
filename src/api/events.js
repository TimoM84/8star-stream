"use strict";
// Events, sessions, languages, copying, status and phase, dashboard.
const { fail } = require("../http");
const { can, scope } = require("../auth");
const { id, now, cleanLine, clean, json, slugify, isHttpUrl, hashSecret } = require("../util");
const { schedulePhase, publicPhase, vodAvailable, PHASES } = require("../phase");
const { diff, routeOut } = require("./common");
const { brandingIn } = require("./org");

const STATUSES = ["draft", "test", "scheduled", "archived"];
const ACCESS = ["public", "code", "registration"];
const isTime = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));
const iso = (s) => new Date(Date.parse(s)).toISOString();
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;
// "nl" → "Nederlands": the language's own name, as a sensible default.
const languageName = (code) => {
  try {
    const n = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return n ? n.charAt(0).toLocaleUpperCase(code) + n.slice(1) : code;
  } catch {
    return code;
  }
};

module.exports = (r, app) => {
  const { db, load, tx } = app;

  // ---- Output ------------------------------------------------------------
  const watchUrl = (req, e) => app.publicUrl(req) + "/w/" + e.slug;
  const embedCode = (url) =>
    '<iframe src="' +
    url +
    '?embed=1" title="Livestream" style="width:100%;height:900px;border:0" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>';
  const eventOut = (req, e) => {
    const url = watchUrl(req, e);
    return {
      id: e.id,
      tenantId: e.tenant_id,
      tenantName: db.prepare("SELECT name FROM tenants WHERE id = ?").get(e.tenant_id)?.name || "",
      customerId: e.customer_id,
      customerName: e.customer_id ? db.prepare("SELECT name FROM customers WHERE id = ?").get(e.customer_id)?.name || "" : "",
      slug: e.slug,
      reference: e.reference,
      title: e.title,
      status: e.status,
      access: e.access,
      hasAccessCode: Boolean(e.access_code),
      chatUrl: e.chat_url,
      branding: json(e.branding, {}),
      modules: json(e.modules, {}),
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      watchUrl: url,
      embedCode: embedCode(url),
    };
  };
  const sessionOut = (s, e) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    room: s.room,
    startAt: s.start_at,
    endAt: s.end_at,
    phaseOverride: s.phase_override,
    phase: schedulePhase(s, e),
    sort: s.sort,
  });
  const languageOut = (l) => ({ id: l.id, code: l.code, name: l.name, isDefault: Boolean(l.is_default), active: Boolean(l.active), sort: l.sort });
  const variantOut = (v, s, e) => ({
    sessionId: v.session_id,
    languageId: v.language_id,
    activeSlot: v.active_slot,
    preMedia: json(v.pre_media, {}),
    afterMedia: json(v.after_media, {}),
    vod: json(v.vod, {}),
    vodAvailable: vodAvailable(v.vod),
    phase: s ? publicPhase(s, e, v) : null,
  });

  const sessionsOf = (eventId) => db.prepare("SELECT * FROM sessions WHERE event_id = ? ORDER BY start_at, sort").all(eventId);
  const languagesOf = (eventId) => db.prepare("SELECT * FROM languages WHERE event_id = ? ORDER BY is_default DESC, sort, name").all(eventId);
  // Every session × language has a variant row (media, VOD, active route).
  const ensureVariants = (eventId) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO variants (session_id, language_id)
         SELECT s.id, l.id FROM sessions s JOIN languages l ON l.event_id = s.event_id WHERE s.event_id = ?`,
      )
      .run(eventId);

  function bundle(ctx, e) {
    const sessions = sessionsOf(e.id),
      byId = new Map(sessions.map((s) => [s.id, s]));
    const variants = db
      .prepare("SELECT v.* FROM variants v JOIN sessions s ON s.id = v.session_id WHERE s.event_id = ?")
      .all(e.id)
      .map((v) => variantOut(v, byId.get(v.session_id), e));
    const routes = db
      .prepare("SELECT r.* FROM routes r JOIN sessions s ON s.id = r.session_id WHERE s.event_id = ?")
      .all(e.id)
      .map((rt) => routeOut(rt, can(ctx.user, "streams")));
    const form = db.prepare("SELECT enabled FROM forms WHERE event_id = ?").get(e.id);
    return {
      event: eventOut(ctx.req, e),
      sessions: sessions.map((s) => sessionOut(s, e)),
      languages: languagesOf(e.id).map(languageOut),
      variants,
      routes,
      registrationEnabled: Boolean(form?.enabled),
    };
  }

  // ---- Events ------------------------------------------------------------
  r.get(
    "/api/admin/events",
    (ctx) => {
      const s = scope(ctx.user, "e.tenant_id");
      const status = ctx.query.get("status");
      const rows = db
        .prepare(
          `SELECT e.*, c.name AS customer_name, t.name AS tenant_name,
                  (SELECT MIN(start_at) FROM sessions x WHERE x.event_id = e.id) AS first_start,
                  (SELECT MAX(end_at) FROM sessions x WHERE x.event_id = e.id) AS last_end,
                  (SELECT COUNT(*) FROM sessions x WHERE x.event_id = e.id) AS session_count,
                  (SELECT COUNT(*) FROM languages l WHERE l.event_id = e.id AND l.active = 1) AS language_count
           FROM events e LEFT JOIN customers c ON c.id = e.customer_id JOIN tenants t ON t.id = e.tenant_id
           WHERE ${s.where} ${status === "active" ? "AND e.status != 'archived'" : status ? "AND e.status = ?" : ""}
           ORDER BY first_start DESC`,
        )
        .all(...s.params, ...(status && status !== "active" ? [status] : []));
      return rows.map((e) => ({
        id: e.id,
        slug: e.slug,
        reference: e.reference,
        title: e.title,
        status: e.status,
        access: e.access,
        customerName: e.customer_name || "",
        tenantName: e.tenant_name,
        firstStart: e.first_start,
        lastEnd: e.last_end,
        sessions: e.session_count,
        languages: e.language_count,
      }));
    },
    { perm: "events.view" },
  );

  function nextReference(tenantId) {
    const t = db.prepare("SELECT name FROM tenants WHERE id = ?").get(tenantId);
    const prefix = (String(t?.name || "EVT").normalize("NFKD").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) || "EVT") + "-" + new Date().getFullYear() + "-";
    const last = db
      .prepare("SELECT reference FROM events WHERE tenant_id = ? AND reference LIKE ? ORDER BY reference DESC LIMIT 1")
      .get(tenantId, prefix + "%");
    const n = last ? Number(last.reference.slice(prefix.length)) || 0 : 0;
    return prefix + String(n + 1).padStart(4, "0");
  }
  function uniqueSlug(title) {
    const base = slugify(title) || "event";
    if (!db.prepare("SELECT 1 FROM events WHERE slug = ?").get(base)) return base;
    for (let i = 2; i < 50; i++) if (!db.prepare("SELECT 1 FROM events WHERE slug = ?").get(base + "-" + i)) return base + "-" + i;
    return base.slice(0, 40) + "-" + id(6);
  }

  r.post(
    "/api/admin/events",
    (ctx) => {
      const b = ctx.body;
      const title = cleanLine(b.title, 160);
      if (!title) fail(400, "Enter a title.");
      let customer = null,
        tenantId;
      if (b.customerId) {
        customer = load.customer(ctx.user, b.customerId);
        tenantId = customer.tenant_id;
      } else tenantId = load.targetTenant(ctx.user, b.tenantId);
      const start = isTime(b.startAt) ? iso(b.startAt) : new Date(Date.now() + 7 * 864e5).toISOString();
      const end = isTime(b.endAt) ? iso(b.endAt) : new Date(Date.parse(start) + 2 * 3600e3).toISOString();
      if (Date.parse(end) <= Date.parse(start)) fail(400, "The end time must be after the start time.");
      const code = String(b.languageCode || "nl").trim().toLowerCase();
      if (!LANGUAGE_CODE.test(code)) fail(400, "Enter a valid language code, such as nl or en.");
      const langName = cleanLine(b.languageName, 60) || languageName(code);
      const e = {
        id: id(),
        tenant_id: tenantId,
        customer_id: customer?.id || null,
        slug: uniqueSlug(title),
        reference: nextReference(tenantId),
        title,
        branding: customer ? customer.branding : JSON.stringify({ title }),
      };
      const t = now();
      tx(() => {
        db.prepare(
          "INSERT INTO events (id, tenant_id, customer_id, slug, reference, title, branding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(e.id, e.tenant_id, e.customer_id, e.slug, e.reference, e.title, e.branding, t, t);
        db.prepare("INSERT INTO sessions (id, event_id, title, start_at, end_at) VALUES (?, ?, ?, ?, ?)").run(id(), e.id, title, start, end);
        db.prepare("INSERT INTO languages (id, event_id, code, name, is_default, active) VALUES (?, ?, ?, ?, 1, 1)").run(id(), e.id, code, langName);
        ensureVariants(e.id);
      });
      load.audit(ctx.user, tenantId, "event.create", e.id, { title, reference: e.reference });
      return bundle(ctx, db.prepare("SELECT * FROM events WHERE id = ?").get(e.id));
    },
    { perm: "events.edit" },
  );

  r.get("/api/admin/events/:id", (ctx) => bundle(ctx, load.event(ctx.user, ctx.params.id)), { perm: "events.view" });

  r.patch(
    "/api/admin/events/:id",
    async (ctx) => {
      const e = load.event(ctx.user, ctx.params.id),
        b = ctx.body;
      const next = {
        title: b.title === undefined ? e.title : cleanLine(b.title, 160),
        reference: b.reference === undefined ? e.reference : cleanLine(b.reference, 60),
        access: b.access ?? e.access,
        chat_url: b.chatUrl === undefined ? e.chat_url : String(b.chatUrl || "").trim().slice(0, 500),
        branding: b.branding === undefined ? e.branding : JSON.stringify(brandingIn(b.branding)),
        modules:
          b.modules === undefined
            ? e.modules
            : JSON.stringify({ chat: Boolean(b.modules.chat), subtitles: Boolean(b.modules.subtitles), other: cleanLine(b.modules.other, 120) }),
        customer_id: b.customerId === undefined ? e.customer_id : b.customerId ? load.customer(ctx.user, b.customerId).id : null,
        slug: e.slug,
        access_code: e.access_code,
      };
      if (!next.title) fail(400, "Enter a title.");
      if (!next.reference) fail(400, "Enter a project reference.");
      if (!ACCESS.includes(next.access)) fail(400, "Invalid request.");
      if (next.chat_url && !(isHttpUrl(next.chat_url) && next.chat_url.startsWith("https://"))) fail(400, "The chat link must start with https://.");
      if (next.customer_id && db.prepare("SELECT tenant_id FROM customers WHERE id = ?").get(next.customer_id).tenant_id !== e.tenant_id)
        fail(400, "This customer belongs to another environment.");
      if (b.slug !== undefined && b.slug !== e.slug) {
        if (e.status !== "draft") fail(400, "The watch link can only be changed while the event is a draft.");
        const s = slugify(b.slug);
        if (s.length < 3) fail(400, "Use at least 3 letters or digits for the link.");
        if (db.prepare("SELECT 1 FROM events WHERE slug = ? AND id != ?").get(s, e.id)) fail(409, "This link is already in use.");
        next.slug = s;
      }
      if (b.accessCode !== undefined) {
        const code = String(b.accessCode || "").trim();
        if (code && code.length < 4) fail(400, "Use at least 4 characters for the access code.");
        next.access_code = code ? await hashSecret(code) : "";
      }
      if (next.access === "code" && !next.access_code) fail(400, "Set an access code first.");
      db.prepare(
        `UPDATE events SET title = ?, reference = ?, access = ?, access_code = ?, chat_url = ?, branding = ?, modules = ?, customer_id = ?, slug = ?, updated_at = ? WHERE id = ?`,
      ).run(next.title, next.reference, next.access, next.access_code, next.chat_url, next.branding, next.modules, next.customer_id, next.slug, now(), e.id);
      const changes = diff(e, next, ["title", "reference", "access", "chat_url", "branding", "modules", "customer_id", "slug"]);
      if (next.access_code !== e.access_code) changes.access_code = ["", "changed"];
      load.audit(ctx.user, e.tenant_id, "event.update", e.id, changes);
      return bundle(ctx, db.prepare("SELECT * FROM events WHERE id = ?").get(e.id));
    },
    { perm: "events.edit" },
  );

  // Status: technicians put an event in test; admins schedule and archive.
  r.post(
    "/api/admin/events/:id/status",
    (ctx) => {
      if (!can(ctx.user, "live") && !can(ctx.user, "events.edit")) fail(403, "You do not have permission for this action.");
      const e = load.event(ctx.user, ctx.params.id),
        status = ctx.body.status;
      if (!STATUSES.includes(status)) fail(400, "Invalid request.");
      if (status === "archived" && !can(ctx.user, "events.edit")) fail(403, "You do not have permission for this action.");
      db.prepare("UPDATE events SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), e.id);
      load.audit(ctx.user, e.tenant_id, "event.status", e.id, { status: [e.status, status] });
      return bundle(ctx, { ...e, status });
    },
    { perm: "events.view" },
  );

  // Copy for a recurring production: sessions, languages, stream settings,
  // media, pages, registration form and branding. No registrations, VODs or
  // usage. The copy starts as a draft with a new link and reference.
  r.post(
    "/api/admin/events/:id/copy",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      const title = cleanLine(ctx.body.title, 160) || e.title;
      const shiftMs = Number(ctx.body.shiftDays || 0) * 864e5;
      const n = { id: id(), slug: uniqueSlug(title), reference: nextReference(e.tenant_id) };
      const t = now();
      tx(() => {
        db.prepare(
          `INSERT INTO events (id, tenant_id, customer_id, slug, reference, title, status, access, access_code, chat_url, branding, modules, created_at, updated_at)
           SELECT ?, tenant_id, customer_id, ?, ?, ?, 'draft', access, access_code, chat_url, branding, modules, ?, ? FROM events WHERE id = ?`,
        ).run(n.id, n.slug, n.reference, title, t, t, e.id);
        const langMap = new Map();
        for (const l of languagesOf(e.id)) {
          const lid = id();
          langMap.set(l.id, lid);
          db.prepare("INSERT INTO languages (id, event_id, code, name, is_default, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            lid,
            n.id,
            l.code,
            l.name,
            l.is_default,
            l.active,
            l.sort,
          );
        }
        for (const s of sessionsOf(e.id)) copySession(s, n.id, langMap, shiftMs);
        for (const p of db.prepare("SELECT * FROM pages WHERE event_id = ?").all(e.id))
          db.prepare(
            "INSERT INTO pages (event_id, phase, language_id, draft_html, published_html, draft_at, draft_by, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(n.id, p.phase, langMap.get(p.language_id), p.draft_html, p.published_html, t, ctx.user.email, p.published_html ? t : null, p.published_html ? ctx.user.email : null);
        const f = db.prepare("SELECT * FROM forms WHERE event_id = ?").get(e.id);
        if (f)
          db.prepare("INSERT INTO forms (event_id, enabled, mode, fields, texts, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)").run(
            n.id,
            f.enabled,
            f.mode,
            f.fields,
            f.texts,
            t,
          );
      });
      load.audit(ctx.user, e.tenant_id, "event.copy", n.id, { from: e.id, title, reference: n.reference });
      return bundle(ctx, db.prepare("SELECT * FROM events WHERE id = ?").get(n.id));
    },
    { perm: "events.edit" },
  );

  // Copies a session with its routes and media (not the VOD) into an event.
  function copySession(s, eventId, langMap, shiftMs = 0, title = s.title) {
    const sid = id();
    const shift = (v) => new Date(Date.parse(v) + shiftMs).toISOString();
    db.prepare("INSERT INTO sessions (id, event_id, title, description, room, start_at, end_at, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      sid,
      eventId,
      title,
      s.description,
      s.room,
      shift(s.start_at),
      shift(s.end_at),
      s.sort,
    );
    for (const v of db.prepare("SELECT * FROM variants WHERE session_id = ?").all(s.id))
      if (langMap.has(v.language_id))
        db.prepare("INSERT INTO variants (session_id, language_id, active_slot, pre_media, after_media) VALUES (?, ?, 'primary', ?, ?)").run(
          sid,
          langMap.get(v.language_id),
          v.pre_media,
          v.after_media,
        );
    for (const rt of db.prepare("SELECT * FROM routes WHERE session_id = ?").all(s.id))
      if (langMap.has(rt.language_id))
        db.prepare("INSERT INTO routes (id, session_id, language_id, slot, provider, config, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          id(),
          sid,
          langMap.get(rt.language_id),
          rt.slot,
          rt.provider,
          rt.config,
          rt.bitrate_kbps,
        );
    ensureVariants(eventId);
    return sid;
  }

  // Permanent deletion: only archived events, confirmed with the reference.
  r.delete(
    "/api/admin/events/:id",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      if (e.status !== "archived") fail(400, "Archive the event before deleting it.");
      if (String(ctx.query.get("confirm") || "") !== e.reference) fail(400, "Type the project reference to confirm.");
      tx(() => {
        for (const t of ["usage_minutes", "viewer_stats"]) db.prepare(`DELETE FROM ${t} WHERE event_id = ?`).run(e.id);
        db.prepare(
          "DELETE FROM route_switches WHERE session_id IN (SELECT id FROM sessions WHERE event_id = ?)",
        ).run(e.id);
        db.prepare("DELETE FROM events WHERE id = ?").run(e.id);
      });
      load.audit(ctx.user, e.tenant_id, "event.delete", e.id, { title: e.title, reference: e.reference });
    },
    { perm: "events.edit" },
  );

  // ---- Sessions ----------------------------------------------------------
  const sessionFields = (b, s = {}) => {
    const out = {
      title: b.title === undefined ? s.title : cleanLine(b.title, 160),
      description: b.description === undefined ? s.description ?? "" : clean(b.description, 2000),
      room: b.room === undefined ? s.room ?? "" : cleanLine(b.room, 120),
      start_at: b.startAt === undefined ? s.start_at : isTime(b.startAt) ? iso(b.startAt) : fail(400, "Enter a valid start time."),
      end_at: b.endAt === undefined ? s.end_at : isTime(b.endAt) ? iso(b.endAt) : fail(400, "Enter a valid end time."),
      sort: b.sort === undefined ? s.sort ?? 0 : Number(b.sort) || 0,
    };
    if (!out.title) fail(400, "Enter a title.");
    if (!out.start_at || !out.end_at) fail(400, "Enter a valid start time.");
    if (Date.parse(out.end_at) <= Date.parse(out.start_at)) fail(400, "The end time must be after the start time.");
    return out;
  };
  r.post(
    "/api/admin/events/:id/sessions",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      const f = sessionFields(ctx.body);
      const sid = id();
      tx(() => {
        db.prepare("INSERT INTO sessions (id, event_id, title, description, room, start_at, end_at, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          sid,
          e.id,
          f.title,
          f.description,
          f.room,
          f.start_at,
          f.end_at,
          f.sort,
        );
        ensureVariants(e.id);
      });
      load.audit(ctx.user, e.tenant_id, "session.create", sid, { event: e.id, title: f.title, start: f.start_at, end: f.end_at });
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );
  r.patch(
    "/api/admin/sessions/:id",
    (ctx) => {
      const { session: s, event: e } = load.session(ctx.user, ctx.params.id);
      const f = sessionFields(ctx.body, s);
      db.prepare("UPDATE sessions SET title = ?, description = ?, room = ?, start_at = ?, end_at = ?, sort = ? WHERE id = ?").run(
        f.title,
        f.description,
        f.room,
        f.start_at,
        f.end_at,
        f.sort,
        s.id,
      );
      load.audit(ctx.user, e.tenant_id, "session.update", s.id, diff(s, f, Object.keys(f)));
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );
  r.post(
    "/api/admin/sessions/:id/copy",
    (ctx) => {
      const { session: s, event: e } = load.session(ctx.user, ctx.params.id);
      const langMap = new Map(languagesOf(e.id).map((l) => [l.id, l.id]));
      const sid = tx(() => copySession(s, e.id, langMap, Number(ctx.body.shiftDays || 0) * 864e5, cleanLine(ctx.body.title, 160) || s.title));
      load.audit(ctx.user, e.tenant_id, "session.copy", sid, { from: s.id });
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );
  r.delete(
    "/api/admin/sessions/:id",
    (ctx) => {
      const { session: s, event: e } = load.session(ctx.user, ctx.params.id);
      if (sessionsOf(e.id).length <= 1) fail(400, "An event needs at least one session.");
      db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
      load.audit(ctx.user, e.tenant_id, "session.delete", s.id, { title: s.title, start: s.start_at });
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );
  // Manual phase. null returns to the schedule.
  r.post(
    "/api/admin/sessions/:id/phase",
    (ctx) => {
      const { session: s, event: e } = load.session(ctx.user, ctx.params.id);
      const phase = ctx.body.phase || null;
      if (phase !== null && !PHASES.includes(phase)) fail(400, "Invalid request.");
      if (e.status !== "scheduled" && phase) fail(400, "Set the event to Scheduled before changing the phase manually.");
      db.prepare("UPDATE sessions SET phase_override = ? WHERE id = ?").run(phase, s.id);
      load.audit(ctx.user, e.tenant_id, "session.phase", s.id, {
        override: [s.phase_override, phase],
        phase: [schedulePhase(s, e), schedulePhase({ ...s, phase_override: phase }, e)],
      });
      return bundle(ctx, e);
    },
    { perm: "live" },
  );

  // ---- Languages ---------------------------------------------------------
  r.post(
    "/api/admin/events/:id/languages",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      const code = String(ctx.body.code || "").trim().toLowerCase(),
        name = cleanLine(ctx.body.name, 60);
      if (!LANGUAGE_CODE.test(code)) fail(400, "Enter a valid language code, such as nl or en.");
      if (!name) fail(400, "Enter a name.");
      if (db.prepare("SELECT 1 FROM languages WHERE event_id = ? AND code = ?").get(e.id, code)) fail(409, "This language already exists.");
      const from = ctx.body.copyFrom ? load.language(ctx.user, ctx.body.copyFrom).language : null;
      if (from && from.event_id !== e.id) fail(400, "Invalid request.");
      const lid = id();
      tx(() => {
        const sort = db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM languages WHERE event_id = ?").get(e.id).n;
        // A new language starts inactive, so viewers only see it once it is set up.
        db.prepare("INSERT INTO languages (id, event_id, code, name, is_default, active, sort) VALUES (?, ?, ?, ?, 0, 0, ?)").run(lid, e.id, code, name, sort);
        ensureVariants(e.id);
        if (from) {
          db.prepare(
            `UPDATE variants SET pre_media = (SELECT pre_media FROM variants v2 WHERE v2.session_id = variants.session_id AND v2.language_id = ?),
                                 after_media = (SELECT after_media FROM variants v2 WHERE v2.session_id = variants.session_id AND v2.language_id = ?)
             WHERE language_id = ?`,
          ).run(from.id, from.id, lid);
          db.prepare(
            `INSERT INTO routes (id, session_id, language_id, slot, provider, config, bitrate_kbps)
             SELECT lower(hex(randomblob(8))), session_id, ?, slot, provider, config, bitrate_kbps FROM routes WHERE language_id = ?`,
          ).run(lid, from.id);
          // Copied page texts become drafts: nothing is published in the new language yet.
          db.prepare(
            `INSERT INTO pages (event_id, phase, language_id, draft_html, draft_at, draft_by)
             SELECT event_id, phase, ?, CASE WHEN draft_html != '' THEN draft_html ELSE published_html END, ?, ? FROM pages WHERE language_id = ?`,
          ).run(lid, now(), ctx.user.email, from.id);
          const f = db.prepare("SELECT * FROM forms WHERE event_id = ?").get(e.id);
          if (f) {
            const texts = json(f.texts, {}),
              fields = json(f.fields, []);
            if (texts[from.code]) texts[code] = texts[from.code];
            for (const fl of fields) if (fl.translations?.[from.code]) fl.translations[code] = fl.translations[from.code];
            db.prepare("UPDATE forms SET texts = ?, fields = ? WHERE event_id = ?").run(JSON.stringify(texts), JSON.stringify(fields), e.id);
          }
        }
      });
      load.audit(ctx.user, e.tenant_id, "language.create", lid, { code, name, copyFrom: from?.code || null });
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );
  r.patch(
    "/api/admin/languages/:id",
    (ctx) => {
      const { language: l, event: e } = load.language(ctx.user, ctx.params.id),
        b = ctx.body;
      const next = {
        name: b.name === undefined ? l.name : cleanLine(b.name, 60),
        active: b.active === undefined ? l.active : b.active ? 1 : 0,
        is_default: b.isDefault ? 1 : l.is_default,
        sort: b.sort === undefined ? l.sort : Number(b.sort) || 0,
      };
      if (!next.name) fail(400, "Enter a name.");
      if (next.is_default && !next.active) fail(400, "The default language must be active.");
      tx(() => {
        if (next.is_default && !l.is_default) db.prepare("UPDATE languages SET is_default = 0 WHERE event_id = ?").run(e.id);
        db.prepare("UPDATE languages SET name = ?, active = ?, is_default = ?, sort = ? WHERE id = ?").run(next.name, next.active, next.is_default, next.sort, l.id);
      });
      load.audit(ctx.user, e.tenant_id, "language.update", l.id, { code: l.code, ...diff(l, next, Object.keys(next)) });
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );
  r.delete(
    "/api/admin/languages/:id",
    (ctx) => {
      const { language: l, event: e } = load.language(ctx.user, ctx.params.id);
      if (l.is_default) fail(400, "The default language cannot be deleted.");
      db.prepare("DELETE FROM languages WHERE id = ?").run(l.id);
      load.audit(ctx.user, e.tenant_id, "language.delete", l.id, { code: l.code, name: l.name });
      return bundle(ctx, e);
    },
    { perm: "events.edit" },
  );

  // ---- Dashboard ---------------------------------------------------------
  r.get(
    "/api/admin/dashboard",
    (ctx) => {
      const s = scope(ctx.user, "e.tenant_id");
      const t = Date.now(),
        week = t + 7 * 864e5,
        soon = t + 14 * 864e5;
      const rows = db
        .prepare(
          `SELECT s.*, e.title AS event_title, e.reference, e.status AS event_status, e.tenant_id, e.slug, e.id AS eid
           FROM sessions s JOIN events e ON e.id = s.event_id WHERE ${s.where} AND e.status != 'archived' ORDER BY s.start_at`,
        )
        .all(...s.params);
      const ev = (x) => ({ status: x.event_status });
      const item = (x, extra = {}) => ({
        eventId: x.eid,
        eventTitle: x.event_title,
        reference: x.reference,
        status: x.event_status,
        sessionId: x.id,
        sessionTitle: x.title,
        startAt: x.start_at,
        endAt: x.end_at,
        ...extra,
      });
      const live = [],
        upcoming = [],
        vodTodo = [];
      for (const x of rows) {
        const phase = schedulePhase(x, ev(x), t);
        if (phase === "live") live.push(item(x, { viewers: app.viewers.current(x.eid, x.id) }));
        else if (x.event_status !== "test" && phase === "pre" && Date.parse(x.start_at) < week) upcoming.push(item(x));
        else if (phase === "after" || phase === "vod") {
          const missing = db
            .prepare(
              `SELECT l.name FROM variants v JOIN languages l ON l.id = v.language_id
               WHERE v.session_id = ? AND l.active = 1 AND (json_extract(v.vod, '$.published') IS NOT 1)`,
            )
            .all(x.id)
            .map((l) => l.name);
          if (missing.length && Date.parse(x.end_at) > t - 60 * 864e5) vodTodo.push(item(x, { languages: missing }));
        }
      }
      const testing = db
        .prepare(`SELECT e.id, e.title, e.reference FROM events e WHERE ${s.where} AND e.status = 'test' ORDER BY e.title`)
        .all(...s.params);
      const warnings = db
        .prepare(
          `SELECT r.id, r.slot, r.signal_detail, r.signal_changed_at, s.id AS sid, s.title AS session_title, l.name AS language,
                  e.id AS eid, e.title AS event_title, e.status, s.start_at, s.end_at, s.phase_override, v.active_slot, v.vod
           FROM routes r JOIN sessions s ON s.id = r.session_id JOIN events e ON e.id = s.event_id JOIN languages l ON l.id = r.language_id
           JOIN variants v ON v.session_id = r.session_id AND v.language_id = r.language_id
           WHERE ${s.where} AND r.signal = 'lost' AND e.status IN ('test','scheduled')`,
        )
        .all(...s.params)
        .filter((w) => w.status === "test" || ["pre", "live"].includes(schedulePhase({ start_at: w.start_at, end_at: w.end_at, phase_override: w.phase_override }, { status: w.status }, t)))
        .map((w) => ({
          routeId: w.id,
          slot: w.slot,
          active: w.slot === w.active_slot,
          detail: w.signal_detail,
          since: w.signal_changed_at,
          eventId: w.eid,
          eventTitle: w.event_title,
          sessionTitle: w.session_title,
          language: w.language,
        }));
      const pendingRegistrations = db
        .prepare(
          `SELECT e.id, e.title, COUNT(*) AS n FROM registrations g JOIN events e ON e.id = g.event_id
           WHERE ${s.where} AND g.status = 'pending' GROUP BY e.id ORDER BY n DESC`,
        )
        .all(...s.params);
      const expiring = db
        .prepare(
          `SELECT e.id AS eid, e.title, s.title AS session_title, l.name AS language, json_extract(v.vod, '$.expireAt') AS expire_at
           FROM variants v JOIN sessions s ON s.id = v.session_id JOIN events e ON e.id = s.event_id JOIN languages l ON l.id = v.language_id
           WHERE ${s.where} AND json_extract(v.vod, '$.published') = 1 AND json_extract(v.vod, '$.unlimited') IS NOT 1
             AND json_extract(v.vod, '$.expireAt') IS NOT NULL`,
        )
        .all(...s.params)
        .filter((x) => Date.parse(x.expire_at) > t && Date.parse(x.expire_at) < soon)
        .map((x) => ({ eventId: x.eid, eventTitle: x.title, sessionTitle: x.session_title, language: x.language, expireAt: x.expire_at }));
      return { live, upcoming, testing, warnings, pendingRegistrations, vodTodo, expiring };
    },
    { perm: "events.view" },
  );

  app.bundle = bundle;
  app.ensureVariants = ensureVariants;
};
