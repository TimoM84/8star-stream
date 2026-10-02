"use strict";
// Usage report (minutes, estimated GB, viewers, modules) and the audit log.
const { fail } = require("../http");
const { scope } = require("../auth");
const { json } = require("../util");
const { csv, xlsx, fileName } = require("../export");
const { exportWords } = require("./words");

const day = (v, fallback) => {
  if (!v) return fallback;
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(400, "Enter a valid date.");
  return new Date(t).toISOString();
};
const round = (n, d = 3) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

module.exports = (r, app) => {
  const { db, load } = app;

  function usage(ctx) {
    const q = ctx.query;
    const from = day(q.get("from"), new Date(Date.now() - 31 * 864e5).toISOString());
    const to = day(q.get("to"), new Date(Date.now() + 864e5).toISOString());
    if (Date.parse(to) <= Date.parse(from)) fail(400, "The end date must be after the start date.");
    const s = scope(ctx.user, "e.tenant_id");
    const where = [s.where, "u.minute >= ?", "u.minute < ?"],
      params = [...s.params, from, to];
    if (q.get("tenant") && ctx.user.platform) where.push("e.tenant_id = ?") && params.push(q.get("tenant"));
    if (q.get("customer")) where.push("e.customer_id = ?") && params.push(q.get("customer"));
    if (q.get("event")) where.push("e.id = ?") && params.push(q.get("event"));
    const rows = db
      .prepare(
        `SELECT u.event_id, u.session_id, u.language_id, u.slot,
                SUM(u.kind = 'live') AS live_minutes, SUM(u.kind = 'test') AS test_minutes, SUM(u.gb_estimate) AS gb,
                MAX(u.viewers) AS peak_minute, MIN(u.minute) AS first_minute, MAX(u.minute) AS last_minute,
                e.reference, e.title AS event_title, e.modules, t.name AS tenant_name, c.name AS customer_name,
                s.title AS session_title, s.start_at, l.code AS language_code, l.name AS language_name,
                vs.peak, vs.plays
         FROM usage_minutes u
         JOIN events e ON e.id = u.event_id JOIN tenants t ON t.id = e.tenant_id
         LEFT JOIN customers c ON c.id = e.customer_id
         LEFT JOIN sessions s ON s.id = u.session_id LEFT JOIN languages l ON l.id = u.language_id
         LEFT JOIN viewer_stats vs ON vs.event_id = u.event_id AND vs.session_id = u.session_id AND vs.language_id = u.language_id
         WHERE ${where.join(" AND ")}
         GROUP BY u.event_id, u.session_id, u.language_id, u.slot
         ORDER BY e.reference, s.start_at, l.code, u.slot`,
      )
      .all(...params);
    // Event totals: live minutes count each minute once, however many
    // language streams were live; language stream minutes add them up.
    const distinct = db
      .prepare(
        `SELECT u.event_id, COUNT(DISTINCT u.minute) AS n FROM usage_minutes u JOIN events e ON e.id = u.event_id
         WHERE ${where.join(" AND ")} AND u.kind = 'live' GROUP BY u.event_id`,
      )
      .all(...params);
    const liveByEvent = new Map(distinct.map((d) => [d.event_id, d.n]));
    const events = new Map();
    const formOn = (eid) => Boolean(db.prepare("SELECT enabled FROM forms WHERE event_id = ?").get(eid)?.enabled);
    for (const x of rows) {
      if (!events.has(x.event_id)) {
        const m = json(x.modules, {});
        events.set(x.event_id, {
          eventId: x.event_id,
          reference: x.reference,
          title: x.event_title,
          customer: x.customer_name || "",
          tenant: x.tenant_name,
          liveMinutes: liveByEvent.get(x.event_id) || 0,
          streamMinutes: 0,
          testMinutes: 0,
          gb: 0,
          peak: 0,
          plays: 0,
          modules: [m.chat && "chat", formOn(x.event_id) && "registration", m.subtitles && "subtitles", m.other].filter(Boolean),
          first: x.first_minute,
          last: x.last_minute,
          seen: new Set(),
        });
      }
      const ev = events.get(x.event_id);
      ev.streamMinutes += x.live_minutes;
      ev.testMinutes += x.test_minutes;
      ev.gb += x.gb;
      ev.first = x.first_minute < ev.first ? x.first_minute : ev.first;
      ev.last = x.last_minute > ev.last ? x.last_minute : ev.last;
      const key = x.session_id + "|" + x.language_id;
      if (!ev.seen.has(key)) {
        ev.seen.add(key);
        ev.peak = Math.max(ev.peak, x.peak || 0);
        ev.plays += x.plays || 0;
      }
    }
    return {
      from,
      to,
      rows: rows.map((x) => ({
        eventId: x.event_id,
        reference: x.reference,
        tenant: x.tenant_name,
        customer: x.customer_name || "",
        event: x.event_title,
        session: x.session_title || "",
        language: x.language_name ? x.language_name + " (" + x.language_code + ")" : "",
        slot: x.slot,
        liveMinutes: x.live_minutes,
        testMinutes: x.test_minutes,
        gb: round(x.gb),
        peak: x.peak || x.peak_minute || 0,
        plays: x.plays || 0,
        first: x.first_minute,
        last: x.last_minute,
      })),
      events: [...events.values()].map(({ seen, ...ev }) => ({ ...ev, gb: round(ev.gb) })),
    };
  }
  r.get("/api/admin/usage", usage, { perm: "usage" });
  r.get(
    "/api/admin/usage/export",
    (ctx) => {
      const u = usage(ctx);
      const w = exportWords(ctx.query.get("lang"));
      const period = u.from.slice(0, 10) + " – " + new Date(Date.parse(u.to) - 1).toISOString().slice(0, 10);
      const header = [w.environment, w.reference, w.customer, w.event, w.session, w.language, w.route, w.period, w.liveMinutes, w.streamMinutes, w.testMinutes, w.gb, w.peak, w.plays, w.storage, w.modules];
      const data = [];
      for (const ev of u.events) {
        for (const x of u.rows.filter((row) => row.eventId === ev.eventId))
          data.push([x.tenant, x.reference, x.customer, x.event, x.session, x.language, w[x.slot] || x.slot, period, "", x.liveMinutes, x.testMinutes, x.gb, x.peak, x.plays, "", ""]);
        data.push([ev.tenant, ev.reference, ev.customer, ev.title, w.total, "", "", period, ev.liveMinutes, ev.streamMinutes, ev.testMinutes, ev.gb, ev.peak, ev.plays, "", ev.modules.join(", ")]);
      }
      const format = ctx.query.get("format") === "xlsx" ? "xlsx" : "csv";
      const refs = [...new Set(u.events.map((e) => e.reference))];
      const fallback = (refs.length === 1 ? refs[0] : "usage") + "_" + u.from.slice(0, 10) + "_" + new Date(Date.parse(u.to) - 1).toISOString().slice(0, 10);
      const name = fileName(ctx.query.get("name") || fallback, format);
      load.audit(ctx.user, ctx.user.tenantId, "usage.export", refs.join(",").slice(0, 200), { format, from: u.from, to: u.to, rows: data.length });
      const body = format === "xlsx" ? xlsx(header, data, w.usage) : Buffer.from(csv(header, data), "utf8");
      ctx.res.writeHead(200, {
        "content-type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="' + name + '"',
        "cache-control": "no-store",
      });
      ctx.res.end(body);
    },
    { perm: "usage" },
  );

  // ---- Audit -------------------------------------------------------------
  r.get(
    "/api/admin/audit",
    (ctx) => {
      const q = ctx.query;
      const where = [],
        params = [];
      if (!ctx.user.platform) where.push("a.tenant_id = ?") && params.push(ctx.user.tenantId);
      if (q.get("action")) where.push("a.action LIKE ?") && params.push(q.get("action").replace(/[%_]/g, "") + "%");
      if (q.get("q")) {
        const like = "%" + q.get("q").replace(/[%_]/g, "") + "%";
        where.push("(a.user_email LIKE ? OR a.target LIKE ? OR a.detail LIKE ?)");
        params.push(like, like, like);
      }
      if (q.get("from")) where.push("a.at >= ?") && params.push(day(q.get("from")));
      if (q.get("to")) where.push("a.at < ?") && params.push(day(q.get("to")));
      if (q.get("before")) where.push("a.id < ?") && params.push(Number(q.get("before")) || 0);
      const limit = Math.min(500, Math.max(1, Number(q.get("limit")) || 200));
      return db
        .prepare(
          `SELECT a.*, t.name AS tenant_name FROM audit a LEFT JOIN tenants t ON t.id = a.tenant_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ${limit}`,
        )
        .all(...params)
        .map((a) => ({
          id: a.id,
          at: a.at,
          tenant: a.tenant_name || "",
          user: a.user_email,
          action: a.action,
          target: a.target,
          detail: json(a.detail, {}),
          result: a.result,
        }));
    },
    { perm: "audit" },
  );
};
