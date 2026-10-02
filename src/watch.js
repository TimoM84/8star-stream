"use strict";
// The public watch page API: one permanent link per event (/w/<slug>).
//
// GET  /api/watch/<slug>/state     what the page shows now (phase, page
//                                  content, stream or VOD, chat, access)
// POST /api/watch/<slug>/code      access code → access token
// POST /api/watch/<slug>/register  registration form
// POST /api/watch/<slug>/beat      viewer count beacon (every 30 s)
//
// The playback URL of a stream is only given out while the session is
// publicly live (never during a test), and only after access is granted.
// The page asks for the state every few seconds, so phase, route and
// language changes reach viewers without reloading.
const crypto = require("node:crypto");
const { fail } = require("./http");
const { id, token, json, sha256, now, cleanLine, verifySecret } = require("./util");
const { schedulePhase, publicPhase } = require("./phase");
const { providerOf } = require("./providers");
const { localField, answersIn } = require("./forms");
const { can } = require("./auth");

const POLL_SECONDS = 6;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

module.exports = (r, app) => {
  const { db, settings, cfg } = app;
  const eventBySlug = db.prepare("SELECT * FROM events WHERE slug = ?");
  const secret = () => settings.get("secret");

  // ---- Access ------------------------------------------------------------
  const codeGrant = (e) => "c." + crypto.createHmac("sha256", secret()).update("code:" + e.id + ":" + e.access_code).digest("base64url").slice(0, 32);
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  // { granted, status } for the access token the page sends.
  function access(e, header) {
    if (e.access === "public") return { granted: true, kind: "public", status: "open" };
    const h = String(header || "");
    if (e.access === "code") return { granted: Boolean(e.access_code) && same(h, codeGrant(e)), kind: "code", status: "none" };
    if (!h.startsWith("r.")) return { granted: false, kind: "registration", status: "none" };
    const g = db.prepare("SELECT status FROM registrations WHERE event_id = ? AND access_token = ?").get(e.id, sha256(h.slice(2)));
    if (!g) return { granted: false, kind: "registration", status: "none" };
    return { granted: g.status === "received" || g.status === "approved", kind: "registration", status: g.status };
  }

  // ---- Variables in page content ------------------------------------------
  function variables(e, s, lang, v, watchUrl) {
    const customer = e.customer_id ? db.prepare("SELECT * FROM customers WHERE id = ?").get(e.customer_id) : null;
    const locale = lang?.code || "nl";
    const fmt = (iso, o) => {
      try {
        return iso ? new Intl.DateTimeFormat(locale, { timeZone: cfg.timeZone, ...o }).format(new Date(iso)) : "";
      } catch {
        return new Intl.DateTimeFormat("en", { timeZone: cfg.timeZone, ...o }).format(new Date(iso));
      }
    };
    const vod = json(v?.vod, {});
    return {
      customer: customer?.name,
      event: e.title,
      session: s?.title,
      date: fmt(s?.start_at, { dateStyle: "long" }),
      start: fmt(s?.start_at, { timeStyle: "short" }),
      end: fmt(s?.end_at, { timeStyle: "short" }),
      room: s?.room,
      language: lang?.name,
      accountManager: customer?.account_manager_name,
      accountManagerEmail: customer?.account_manager_email,
      watchUrl,
      registrationUrl: watchUrl + "#register",
      vodExpires: vod.published && !vod.unlimited && vod.expireAt ? fmt(vod.expireAt, { dateStyle: "long" }) : "",
    };
  }
  // {{name}} → value (escaped); unknown or empty variables leave nothing.
  const render = (html, vars) => String(html || "").replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k) => esc(vars[k] ?? ""));

  // The session the page shows: requested, else live, else the next one,
  // else the one that ended last.
  function pickSession(sessions, e, requested, t) {
    if (requested) {
      const s = sessions.find((x) => x.id === requested);
      if (s) return s;
    }
    const live = sessions.find((x) => schedulePhase(x, e, t) === "live");
    if (live) return live;
    const next = sessions.filter((x) => Date.parse(x.end_at) > t).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))[0];
    if (next) return next;
    return [...sessions].sort((a, b) => Date.parse(b.end_at) - Date.parse(a.end_at))[0];
  }

  // ---- State -------------------------------------------------------------
  const memo = new Map();
  function state(req, slug, q, preview) {
    const e = eventBySlug.get(slug);
    if (!e) fail(404, "This event does not exist.");
    const acc = preview ? { granted: true, kind: e.access, status: "preview" } : access(e, req.headers["x-access"]);
    const key = [slug, q.get("lang") || "", q.get("session") || "", acc.granted, acc.status].join("|");
    if (!preview) {
      const hit = memo.get(key);
      if (hit && hit.until > Date.now()) return hit.value;
    }
    const t = Date.now();
    const all = db.prepare("SELECT * FROM languages WHERE event_id = ? ORDER BY is_default DESC, sort, name").all(e.id);
    const languages = preview ? all : all.filter((l) => l.active);
    const def = languages.find((l) => l.is_default) || languages[0];
    const requested = String(q.get("lang") || "").toLowerCase();
    let lang = languages.find((l) => l.code === requested) || def;
    const languageUnavailable = Boolean(requested && lang?.code !== requested);
    const sessions = db.prepare("SELECT * FROM sessions WHERE event_id = ? ORDER BY start_at, sort").all(e.id);
    const s = pickSession(sessions, e, q.get("session"), t);
    const v = s && lang ? db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?").get(s.id, lang.id) : null;
    let phase = s ? publicPhase(s, e, v, t) : "pre";
    if (preview?.phase) phase = preview.phase;
    // Without access only the pre phase content is shown (the landing page).
    const contentPhase = acc.granted ? phase : "pre";
    const page = lang ? db.prepare("SELECT * FROM pages WHERE event_id = ? AND phase = ? AND language_id = ?").get(e.id, contentPhase, lang.id) : null;
    const watchUrl = app.publicUrl(req) + "/w/" + e.slug;
    const html = render(preview ? page?.draft_html : page?.published_html, variables(e, s, lang, v, watchUrl));
    const out = {
      now: new Date(t).toISOString(),
      poll: POLL_SECONDS,
      event: { slug: e.slug, title: e.title, branding: json(e.branding, {}), access: e.access, status: e.status },
      languages: languages.map((l) => ({ code: l.code, name: l.name, default: Boolean(l.is_default) })),
      language: lang?.code || "",
      languageUnavailable,
      sessions: sessions.map((x) => ({
        id: x.id,
        title: x.title,
        room: x.room,
        startAt: x.start_at,
        endAt: x.end_at,
        phase: schedulePhase(x, e, t),
      })),
      session: s?.id || null,
      phase,
      access: acc,
      html,
      media: null,
      stream: null,
      vod: null,
      chat: null,
      form: null,
    };
    if (acc.granted && v) {
      if (phase === "pre" || phase === "after") {
        const m = json(phase === "pre" ? v.pre_media : v.after_media, {});
        if (m.kind && m.kind !== "none" && m.url) out.media = m;
      }
      if (phase === "live") {
        // Preview never contains the stream: the Green Room is for that.
        const rt = db.prepare("SELECT * FROM routes WHERE session_id = ? AND language_id = ? AND slot = ?").get(s.id, lang.id, v.active_slot);
        const url = rt && !preview ? providerOf(rt.provider).describe(json(rt.config, {})).playbackUrl : "";
        // The signal lets the player show "back in a moment" and reload as
        // soon as the encoder is back.
        out.stream = url ? { url, slot: v.active_slot, signal: rt.signal } : null;
        if (!url && !preview) out.streamUnavailable = true;
      }
      if (phase === "vod") {
        const vod = json(v.vod, {});
        const sub = "/api/watch/" + e.slug + "/subtitle?" + new URLSearchParams({ session: s.id, lang: lang.code }) + "&id=";
        out.vod = {
          url: vod.url,
          trimStart: vod.trimStart ?? null,
          trimEnd: vod.trimEnd ?? null,
          chapters: vod.chapters || [],
          subtitles: (vod.subtitles || []).map((x) => ({ id: x.id, lang: x.lang, label: x.label, url: sub + x.id })),
        };
      }
    }
    if (!acc.granted && v) {
      const m = json(v.pre_media, {});
      if (m.kind && m.kind !== "none" && m.url) out.media = m;
    }
    const modules = json(e.modules, {});
    if (acc.granted && modules.chat && e.chat_url && (phase === "pre" || phase === "live")) {
      const u = new URL(e.chat_url);
      if (lang) u.searchParams.set("lang", lang.code.slice(0, 2));
      out.chat = { url: u.href };
    }
    const f = db.prepare("SELECT * FROM forms WHERE event_id = ?").get(e.id);
    // The form: required before access (until a registration exists), or as
    // an optional sign-up on an open page.
    const needsForm = e.access === "registration" ? !acc.granted && acc.status === "none" : acc.granted && phase !== "vod";
    if (f?.enabled && lang && needsForm) {
      const texts = json(f.texts, {});
      const tx = texts[lang.code] || texts[def?.code] || {};
      out.form = {
        required: e.access === "registration",
        approval: f.mode === "approval",
        intro: tx.intro || "",
        privacy: tx.privacy || "",
        submit: tx.submit || "",
        fields: json(f.fields, []).filter((x) => x.active).map((x) => localField(x, lang.code)),
      };
    }
    if (!preview) {
      if (memo.size > 5000) memo.clear();
      memo.set(key, { until: Date.now() + 2000, value: out });
    }
    return out;
  }
  app.clearWatchCache = () => memo.clear();

  r.get(
    "/api/watch/:slug/state",
    (ctx) => {
      let preview = null;
      if (ctx.query.get("preview")) {
        // Draft preview for staff: page content as it will look, per phase.
        const user = app.auth.current(ctx.req);
        if (!user || !can(user, "events.view")) fail(401, "Please sign in.");
        const e = eventBySlug.get(ctx.params.slug);
        if (!e || !(user.platform || user.tenantId === e.tenant_id)) fail(404, "This event does not exist.");
        const phase = ctx.query.get("phase");
        preview = { phase: ["pre", "live", "after", "vod"].includes(phase) ? phase : null };
      }
      const out = state(ctx.req, ctx.params.slug, ctx.query, preview);
      const cacheable = out.event.access === "public" && !preview;
      ctx.res.setHeader("cache-control", cacheable ? "public, max-age=3" : "private, no-store");
      ctx.res.setHeader("vary", "x-access");
      ctx.res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      ctx.res.end(JSON.stringify(out));
    },
    { auth: false },
  );

  // Subtitle text of a published recording (WebVTT), for viewers with access.
  r.get(
    "/api/watch/:slug/subtitle",
    (ctx) => {
      const st = state(ctx.req, ctx.params.slug, new URLSearchParams({ lang: ctx.query.get("lang") || "", session: ctx.query.get("session") || "" }), null);
      if (!st.access.granted || st.phase !== "vod") fail(404, "This event does not exist.");
      const e = eventBySlug.get(ctx.params.slug);
      const l = db.prepare("SELECT id FROM languages WHERE event_id = ? AND code = ?").get(e.id, st.language);
      const v = l && st.session ? db.prepare("SELECT vod FROM variants WHERE session_id = ? AND language_id = ?").get(st.session, l.id) : null;
      const track = json(v?.vod, {}).subtitles?.find((x) => x.id === ctx.query.get("id"));
      if (!track) fail(404, "This event does not exist.");
      ctx.res.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
      ctx.res.end(track.vtt);
    },
    { auth: false },
  );

  // ---- Access code -------------------------------------------------------
  const attempts = new Map();
  const limited = (key, max, windowMs) => {
    const t = Date.now(),
      a = attempts.get(key);
    if (a && t - a.first < windowMs) {
      if (a.count >= max) return true;
      a.count++;
    } else attempts.set(key, { count: 1, first: t });
    if (attempts.size > 50000) attempts.clear();
    return false;
  };
  r.post(
    "/api/watch/:slug/code",
    async (ctx) => {
      const e = eventBySlug.get(ctx.params.slug);
      if (!e || e.access !== "code" || !e.access_code) fail(404, "This event does not exist.");
      if (limited("code|" + ctx.ip + "|" + e.id, 10, 10 * 60000)) fail(429, "Too many attempts. Please try again in a few minutes.");
      if (!(await verifySecret(String(ctx.body.code || "").trim(), e.access_code))) fail(403, "This access code is not correct.");
      return { token: codeGrant(e) };
    },
    { auth: false },
  );

  // ---- Registration -----------------------------------------------------
  r.post(
    "/api/watch/:slug/register",
    (ctx) => {
      const e = eventBySlug.get(ctx.params.slug);
      if (!e) fail(404, "This event does not exist.");
      const f = db.prepare("SELECT * FROM forms WHERE event_id = ?").get(e.id);
      if (!f?.enabled) fail(404, "Registration is not open.");
      if (limited("reg|" + ctx.ip + "|" + e.id, 20, 10 * 60000)) fail(429, "Too many attempts. Please try again in a few minutes.");
      const langs = db.prepare("SELECT * FROM languages WHERE event_id = ? AND active = 1").all(e.id);
      const lang = langs.find((l) => l.code === ctx.body.language) || langs.find((l) => l.is_default) || langs[0];
      const texts = json(f.texts, {});
      const tx = texts[lang?.code] || texts[langs.find((l) => l.is_default)?.code] || {};
      const approval = e.access === "registration" && f.mode === "approval";
      // Honeypot: automated submissions fill the hidden field; they get the
      // normal answer but nothing is stored.
      if (cleanLine(ctx.body.website, 200)) return { status: approval ? "pending" : "received", granted: false, message: tx.confirmation || "" };
      const fields = json(f.fields, []);
      const at = now();
      const { answers, errors, email, consent } = answersIn(fields, ctx.body.answers, lang?.code || "", at);
      if (Object.keys(errors).length) fail(422, "Please check the highlighted fields.", { errors });
      const status = approval ? "pending" : "received";
      const secretToken = token(24);
      db.prepare(
        `INSERT INTO registrations (id, event_id, session_id, language, form_version, fields, answers, email, status, consent, access_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id(),
        e.id,
        ctx.body.session && db.prepare("SELECT 1 FROM sessions WHERE id = ? AND event_id = ?").get(String(ctx.body.session), e.id) ? String(ctx.body.session) : null,
        lang?.code || "",
        f.version,
        f.fields,
        JSON.stringify(answers),
        email,
        status,
        JSON.stringify(consent),
        sha256(secretToken),
        at,
      );
      return {
        status,
        token: "r." + secretToken,
        granted: e.access === "registration" ? !approval : true,
        message: approval ? tx.pending || "" : tx.confirmation || "",
      };
    },
    { auth: false },
  );

  // ---- Viewer beacon ------------------------------------------------------
  r.post(
    "/api/watch/:slug/beat",
    (ctx) => {
      const viewer = String(ctx.body.viewer || "");
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(viewer)) fail(400, "Invalid request.");
      const q = new URLSearchParams({ lang: String(ctx.body.lang || ""), session: String(ctx.body.session || "") });
      const st = state(ctx.req, ctx.params.slug, q, null);
      if (!st.access.granted || !(st.phase === "live" || st.phase === "vod") || !st.session) return;
      const e = eventBySlug.get(ctx.params.slug);
      const l = db.prepare("SELECT id FROM languages WHERE event_id = ? AND code = ?").get(e.id, st.language);
      if (l) app.viewers.beat(viewer, e.id, st.session, l.id);
    },
    { auth: false },
  );

  // Content-Security-Policy of the watch page: chat and approved iframe
  // sources may be framed; the page itself may be embedded anywhere allowed
  // by FRAME_ANCESTORS.
  function csp(slug) {
    const e = eventBySlug.get(slug);
    const frames = new Set();
    if (e?.chat_url) {
      try {
        frames.add(new URL(e.chat_url).origin);
      } catch {}
    }
    for (const h of settings.get("iframeHosts", [])) frames.add("https://" + h).add("https://*." + h);
    const ancestors = cfg.frameAncestors.trim() === "*" ? "*" : "'self' " + cfg.frameAncestors;
    return (
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
      "media-src 'self' blob: https: http:; connect-src 'self' https: http:; worker-src 'self' blob:; " +
      "frame-src " +
      ([...frames].join(" ") || "'none'") +
      "; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors " +
      ancestors
    );
  }
  return { csp, state };
};
