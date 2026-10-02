"use strict";
// Watch page content (per phase and language, draft and published),
// templates, the media library, pre/after media and VOD per language.
const fs = require("node:fs");
const path = require("node:path");
const { fail, readBody } = require("../http");
const { can, scope } = require("../auth");
const { id, now, cleanLine, clean, json, isHttpUrl } = require("../util");
const { check, clean: cleanHtml } = require("../sanitize");
const { PHASES } = require("../phase");

const MAX_HTML = 200_000;
const IMAGE_TYPES = {
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  "image/gif": { ext: "gif", magic: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
};

// A media address: the media library or an http(s) URL.
const mediaUrl = (v) => {
  const s = String(v || "").trim().slice(0, 1000);
  if (!s) return "";
  if (/^\/media\/[a-z0-9]{16}\.(png|jpg|webp|gif)$/.test(s) || isHttpUrl(s)) return s;
  fail(400, "Use an address from the media library or one that starts with https://.");
};
// Time in seconds from a number or "h:mm:ss" / "mm:ss".
const seconds = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  if (typeof v === "number") return v >= 0 && v < 864000 ? Math.round(v * 10) / 10 : fail(400, "Enter a valid time.");
  const parts = String(v).trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) fail(400, "Enter a valid time.");
  return parts.reduce((a, n) => a * 60 + n, 0);
};
const dateOrNull = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? fail(400, "Enter a valid date.") : new Date(t).toISOString();
};

module.exports = (r, app) => {
  const { db, load, settings, cfg } = app;
  const iframeHosts = () => settings.get("iframeHosts", []);
  // Refuses HTML with problems (listed in plain language); returns the
  // normalised HTML otherwise.
  const acceptHtml = (html) => {
    const s = String(html ?? "");
    if (s.length > MAX_HTML) fail(413, "The content is too long.");
    const problems = check(s, iframeHosts());
    if (problems.length) fail(422, "This content cannot be saved.", { problems });
    return cleanHtml(s, iframeHosts());
  };

  // ---- Pages -------------------------------------------------------------
  const pageOut = (p) => ({
    phase: p.phase,
    languageId: p.language_id,
    draftHtml: p.draft_html,
    publishedHtml: p.published_html,
    draftAt: p.draft_at,
    draftBy: p.draft_by,
    publishedAt: p.published_at,
    publishedBy: p.published_by,
    unpublished: p.draft_html !== p.published_html,
  });
  const pageKey = (ctx) => {
    const e = load.event(ctx.user, ctx.params.id);
    if (!PHASES.includes(ctx.params.phase)) fail(400, "Invalid request.");
    const l = db.prepare("SELECT * FROM languages WHERE id = ? AND event_id = ?").get(ctx.params.lid, e.id);
    if (!l) fail(404, "Not found.");
    return { e, l, phase: ctx.params.phase };
  };
  const getPage = (eventId, phase, languageId) =>
    db.prepare("SELECT * FROM pages WHERE event_id = ? AND phase = ? AND language_id = ?").get(eventId, phase, languageId);

  r.get(
    "/api/admin/events/:id/pages",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      return db.prepare("SELECT * FROM pages WHERE event_id = ?").all(e.id).map(pageOut);
    },
    { perm: "events.view" },
  );
  r.put(
    "/api/admin/events/:id/pages/:phase/:lid",
    (ctx) => {
      const { e, l, phase } = pageKey(ctx);
      const html = acceptHtml(ctx.body.html);
      const t = now();
      db.prepare(
        `INSERT INTO pages (event_id, phase, language_id, draft_html, draft_at, draft_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id, phase, language_id) DO UPDATE SET draft_html = excluded.draft_html, draft_at = excluded.draft_at, draft_by = excluded.draft_by`,
      ).run(e.id, phase, l.id, html, t, ctx.user.email);
      load.audit(ctx.user, e.tenant_id, "page.save", e.id, { phase, language: l.code, length: html.length });
      return pageOut(getPage(e.id, phase, l.id));
    },
    { perm: "pages" },
  );
  r.post(
    "/api/admin/events/:id/pages/:phase/:lid/publish",
    (ctx) => {
      const { e, l, phase } = pageKey(ctx);
      const p = getPage(e.id, phase, l.id);
      if (!p) fail(400, "Save the page first.");
      // Checked again: the approved iframe sources may have changed.
      const html = acceptHtml(p.draft_html);
      db.prepare("UPDATE pages SET published_html = ?, draft_html = ?, published_at = ?, published_by = ? WHERE event_id = ? AND phase = ? AND language_id = ?").run(
        html,
        html,
        now(),
        ctx.user.email,
        e.id,
        phase,
        l.id,
      );
      load.audit(ctx.user, e.tenant_id, "page.publish", e.id, { phase, language: l.code, length: [p.published_html.length, html.length] });
      return pageOut(getPage(e.id, phase, l.id));
    },
    { perm: "pages" },
  );
  r.post(
    "/api/admin/events/:id/pages/:phase/:lid/revert",
    (ctx) => {
      const { e, l, phase } = pageKey(ctx);
      const p = getPage(e.id, phase, l.id);
      if (!p) fail(404, "Not found.");
      db.prepare("UPDATE pages SET draft_html = published_html, draft_at = ?, draft_by = ? WHERE event_id = ? AND phase = ? AND language_id = ?").run(
        now(),
        ctx.user.email,
        e.id,
        phase,
        l.id,
      );
      load.audit(ctx.user, e.tenant_id, "page.revert", e.id, { phase, language: l.code });
      return pageOut(getPage(e.id, phase, l.id));
    },
    { perm: "pages" },
  );
  // Checks HTML without saving (the editor shows problems while typing).
  r.post("/api/admin/html/check", (ctx) => ({ problems: check(String(ctx.body.html ?? ""), iframeHosts()) }), { perm: "pages" });

  // ---- Templates ---------------------------------------------------------
  const templateOut = (t) => ({
    id: t.id,
    tenantId: t.tenant_id,
    central: !t.tenant_id,
    tenantName: t.tenant_name || "",
    name: t.name,
    html: t.html,
    createdBy: t.created_by,
    createdAt: t.created_at,
  });
  r.get(
    "/api/admin/templates",
    (ctx) => {
      const s = scope(ctx.user, "t.tenant_id");
      return db
        .prepare(
          `SELECT t.*, n.name AS tenant_name FROM templates t LEFT JOIN tenants n ON n.id = t.tenant_id
           WHERE t.tenant_id IS NULL OR ${s.where} ORDER BY t.tenant_id IS NOT NULL, t.name`,
        )
        .all(...s.params)
        .map(templateOut);
    },
    { perm: "pages" },
  );
  const mayEditTemplate = (user, t) => {
    if (!t.tenant_id && !can(user, "templates.central")) fail(403, "Only the platform can change central templates.");
  };
  r.post(
    "/api/admin/templates",
    (ctx) => {
      const name = cleanLine(ctx.body.name, 120);
      if (!name) fail(400, "Enter a name.");
      const central = Boolean(ctx.body.central);
      if (central && !can(ctx.user, "templates.central")) fail(403, "Only the platform can change central templates.");
      const t = {
        id: id(),
        tenant_id: central ? null : load.targetTenant(ctx.user, ctx.body.tenantId),
        name,
        html: acceptHtml(ctx.body.html),
        created_by: ctx.user.email,
        created_at: now(),
      };
      db.prepare("INSERT INTO templates (id, tenant_id, name, html, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        t.id,
        t.tenant_id,
        t.name,
        t.html,
        t.created_by,
        t.created_at,
      );
      load.audit(ctx.user, t.tenant_id, "template.create", t.id, { name, central });
      return templateOut(t);
    },
    { perm: "pages" },
  );
  r.patch(
    "/api/admin/templates/:id",
    (ctx) => {
      const t = load.template(ctx.user, ctx.params.id);
      mayEditTemplate(ctx.user, t);
      const name = ctx.body.name === undefined ? t.name : cleanLine(ctx.body.name, 120);
      const html = ctx.body.html === undefined ? t.html : acceptHtml(ctx.body.html);
      if (!name) fail(400, "Enter a name.");
      db.prepare("UPDATE templates SET name = ?, html = ? WHERE id = ?").run(name, html, t.id);
      load.audit(ctx.user, t.tenant_id, "template.update", t.id, { name: [t.name, name], length: [t.html.length, html.length] });
      return templateOut({ ...t, name, html });
    },
    { perm: "pages" },
  );
  r.delete(
    "/api/admin/templates/:id",
    (ctx) => {
      const t = load.template(ctx.user, ctx.params.id);
      mayEditTemplate(ctx.user, t);
      db.prepare("DELETE FROM templates WHERE id = ?").run(t.id);
      load.audit(ctx.user, t.tenant_id, "template.delete", t.id, { name: t.name });
    },
    { perm: "pages" },
  );

  // ---- Media library (images) -------------------------------------------
  const mediaDir = path.join(cfg.dataDir, "media");
  const mediaOut = (m) => ({ id: m.id, tenantId: m.tenant_id, name: m.name, mime: m.mime, size: m.size, url: "/media/" + m.file, createdAt: m.created_at });
  // Everyone who edits pages, branding or media can pick images.
  r.get(
    "/api/admin/media",
    (ctx) => {
      const s = scope(ctx.user);
      return db.prepare(`SELECT * FROM media WHERE ${s.where} ORDER BY created_at DESC`).all(...s.params).map(mediaOut);
    },
    { perm: "events.view" },
  );
  r.post(
    "/api/admin/media",
    async (ctx) => {
      const type = String(ctx.req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const kind = IMAGE_TYPES[type];
      if (!kind) fail(415, "Upload a PNG, JPG, WebP or GIF image.");
      const body = await readBody(ctx.req, cfg.maxUploadMb * 1024 * 1024);
      if (!body.length || !kind.magic(body)) fail(415, "Upload a PNG, JPG, WebP or GIF image.");
      let name = "image";
      try {
        name = cleanLine(decodeURIComponent(String(ctx.req.headers["x-file-name"] || "image")), 160) || "image";
      } catch {}
      const m = { id: id(), tenant_id: load.targetTenant(ctx.user, ctx.query.get("tenant")), name, mime: type, size: body.length, created_at: now() };
      m.file = id() + "." + kind.ext;
      fs.writeFileSync(path.join(mediaDir, m.file), body, { flag: "wx" });
      db.prepare("INSERT INTO media (id, tenant_id, name, mime, size, file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        m.id,
        m.tenant_id,
        m.name,
        m.mime,
        m.size,
        m.file,
        m.created_at,
      );
      load.audit(ctx.user, m.tenant_id, "media.upload", m.id, { name, size: m.size });
      return mediaOut(m);
    },
    { perm: "pages", raw: true },
  );
  r.delete(
    "/api/admin/media/:id",
    (ctx) => {
      const m = load.media(ctx.user, ctx.params.id);
      db.prepare("DELETE FROM media WHERE id = ?").run(m.id);
      fs.rmSync(path.join(mediaDir, m.file), { force: true });
      load.audit(ctx.user, m.tenant_id, "media.delete", m.id, { name: m.name });
    },
    { perm: "pages" },
  );

  // ---- Pre and after media per session and language ---------------------
  const mediaIn = (m = {}) => {
    const kind = ["none", "image", "video"].includes(m.kind) ? m.kind : "none";
    const out = { kind, url: kind === "none" ? "" : mediaUrl(m.url), poster: kind === "video" ? mediaUrl(m.poster) : "", loop: Boolean(m.loop) };
    if (kind !== "none" && !out.url) fail(400, "Enter an address for the image or video.");
    return out;
  };
  r.put(
    "/api/admin/sessions/:sid/languages/:lid/media",
    (ctx) => {
      const { session: s, language: l, event: e } = load.sessionLanguage(ctx.user, ctx.params.sid, ctx.params.lid);
      app.ensureVariants(e.id);
      const v = db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?").get(s.id, l.id);
      const pre = ctx.body.pre === undefined ? json(v.pre_media, {}) : mediaIn(ctx.body.pre);
      const after = ctx.body.after === undefined ? json(v.after_media, {}) : mediaIn(ctx.body.after);
      db.prepare("UPDATE variants SET pre_media = ?, after_media = ? WHERE session_id = ? AND language_id = ?").run(JSON.stringify(pre), JSON.stringify(after), s.id, l.id);
      load.audit(ctx.user, e.tenant_id, "media.phase", s.id, { language: l.code, pre: [json(v.pre_media, {}), pre], after: [json(v.after_media, {}), after] });
      return app.bundle(ctx, e);
    },
    { perm: "pages" },
  );

  // ---- VOD per session and language --------------------------------------
  r.put(
    "/api/admin/sessions/:sid/languages/:lid/vod",
    (ctx) => {
      const { session: s, language: l, event: e } = load.sessionLanguage(ctx.user, ctx.params.sid, ctx.params.lid);
      app.ensureVariants(e.id);
      const v = db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?").get(s.id, l.id);
      const before = json(v.vod, {}),
        b = ctx.body;
      const url = mediaUrl(b.url);
      if (url.startsWith("/media/")) fail(400, "Use the address of a video (HLS .m3u8 or MP4).");
      const chapters = (Array.isArray(b.chapters) ? b.chapters : [])
        .slice(0, 200)
        .map((c) => ({ title: cleanLine(c.title, 160), time: seconds(c.time) }))
        .filter((c) => c.title && c.time !== null)
        .sort((a, c) => a.time - c.time);
      const vod = {
        url,
        trimStart: seconds(b.trimStart),
        trimEnd: seconds(b.trimEnd),
        chapters,
        publishAt: dateOrNull(b.publishAt),
        expireAt: dateOrNull(b.expireAt),
        unlimited: Boolean(b.unlimited),
        unlimitedReason: b.unlimited ? clean(b.unlimitedReason, 300) : "",
        // A new or changed recording must be approved (published) again.
        published:
          Boolean(before.published) &&
          before.url === url &&
          (before.trimStart ?? null) === seconds(b.trimStart) &&
          (before.trimEnd ?? null) === seconds(b.trimEnd),
        publishedAt: before.publishedAt || null,
        publishedBy: before.publishedBy || null,
      };
      if (vod.trimStart !== null && vod.trimEnd !== null && vod.trimEnd <= vod.trimStart) fail(400, "The end point must be after the start point.");
      if (vod.unlimited && !vod.unlimitedReason) fail(400, "Enter a reason for unlimited availability.");
      if (!vod.unlimited && vod.publishAt && vod.expireAt && Date.parse(vod.expireAt) <= Date.parse(vod.publishAt))
        fail(400, "The expiry date must be after the publication date.");
      db.prepare("UPDATE variants SET vod = ? WHERE session_id = ? AND language_id = ?").run(JSON.stringify(vod), s.id, l.id);
      const changed = {};
      for (const k of ["url", "trimStart", "trimEnd", "publishAt", "expireAt", "unlimited", "unlimitedReason", "published"])
        if (JSON.stringify(before[k] ?? null) !== JSON.stringify(vod[k] ?? null)) changed[k] = [before[k] ?? null, vod[k]];
      if (JSON.stringify(before.chapters || []) !== JSON.stringify(chapters)) changed.chapters = [(before.chapters || []).length, chapters.length];
      load.audit(ctx.user, e.tenant_id, "vod.update", s.id, { language: l.code, ...changed });
      return app.bundle(ctx, e);
    },
    { perm: "vod" },
  );
  r.post(
    "/api/admin/sessions/:sid/languages/:lid/vod/publish",
    (ctx) => {
      const { session: s, language: l, event: e } = load.sessionLanguage(ctx.user, ctx.params.sid, ctx.params.lid);
      app.ensureVariants(e.id);
      const v = db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?").get(s.id, l.id);
      const vod = json(v.vod, {});
      const publish = Boolean(ctx.body.published);
      if (publish && !vod.url) fail(400, "Add the recording first.");
      if (publish && !vod.unlimited && !vod.expireAt) fail(400, "Set an expiry date or choose unlimited availability.");
      Object.assign(vod, { published: publish, publishedAt: publish ? now() : vod.publishedAt, publishedBy: publish ? ctx.user.email : vod.publishedBy });
      db.prepare("UPDATE variants SET vod = ? WHERE session_id = ? AND language_id = ?").run(JSON.stringify(vod), s.id, l.id);
      load.audit(ctx.user, e.tenant_id, publish ? "vod.publish" : "vod.unpublish", s.id, { language: l.code, url: vod.url, expireAt: vod.expireAt, unlimited: vod.unlimited });
      return app.bundle(ctx, e);
    },
    { perm: "vod" },
  );
};
