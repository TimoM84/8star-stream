"use strict";
// Registration form per event and the registrations received.
const { fail } = require("../http");
const { now, json } = require("../util");
const { fieldsIn, textsIn, display } = require("../forms");
const { csv, xlsx, fileName } = require("../export");
const { exportWords } = require("./words");

const STATUSES = ["received", "pending", "approved", "rejected"];

module.exports = (r, app) => {
  const { db, load } = app;

  const formOf = (eventId) => {
    const f = db.prepare("SELECT * FROM forms WHERE event_id = ?").get(eventId);
    return {
      enabled: Boolean(f?.enabled),
      approval: f?.mode === "approval",
      fields: json(f?.fields, []),
      texts: json(f?.texts, {}),
      version: f?.version || 1,
      updatedAt: f?.updated_at || null,
      registrations: db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?").get(eventId).n,
    };
  };
  r.get("/api/admin/events/:id/form", (ctx) => formOf(load.event(ctx.user, ctx.params.id).id), { perm: "events.view" });
  r.put(
    "/api/admin/events/:id/form",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      const before = formOf(e.id);
      const fields = ctx.body.fields === undefined ? before.fields : fieldsIn(ctx.body.fields);
      const texts = ctx.body.texts === undefined ? before.texts : textsIn(ctx.body.texts);
      const enabled = ctx.body.enabled === undefined ? before.enabled : Boolean(ctx.body.enabled);
      const approval = ctx.body.approval === undefined ? before.approval : Boolean(ctx.body.approval);
      if (enabled && !fields.some((f) => f.active)) fail(400, "Add at least one active field before turning registration on.");
      const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(before.fields);
      const version = before.version + (fieldsChanged && before.registrations ? 1 : 0);
      db.prepare(
        `INSERT INTO forms (event_id, enabled, mode, fields, texts, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode, fields = excluded.fields,
           texts = excluded.texts, version = excluded.version, updated_at = excluded.updated_at`,
      ).run(e.id, enabled ? 1 : 0, approval ? "approval" : "access", JSON.stringify(fields), JSON.stringify(texts), version, now());
      const changes = {};
      if (enabled !== before.enabled) changes.enabled = [before.enabled, enabled];
      if (approval !== before.approval) changes.approval = [before.approval, approval];
      if (fieldsChanged)
        changes.fields = [before.fields.map((f) => f.type + ":" + f.label.slice(0, 40)), fields.map((f) => f.type + ":" + f.label.slice(0, 40))];
      if (JSON.stringify(texts) !== JSON.stringify(before.texts)) changes.texts = ["", "changed"];
      changes.version = version;
      load.audit(ctx.user, e.tenant_id, "form.update", e.id, changes);
      return formOf(e.id);
    },
    { perm: "forms" },
  );

  // All fields that occur in the current form or in stored registrations,
  // in form order; fields that were removed later come last.
  function columns(eventId, rows) {
    const current = formOf(eventId).fields;
    const map = new Map(current.map((f) => [f.id, f]));
    for (const row of rows) for (const f of json(row.fields, [])) if (!map.has(f.id)) map.set(f.id, { ...f, removed: true });
    return [...map.values()];
  }
  function query(ctx, eventId) {
    const q = String(ctx.query.get("q") || "").trim().toLowerCase();
    const status = ctx.query.get("status");
    const rows = db
      .prepare(`SELECT * FROM registrations WHERE event_id = ? ${STATUSES.includes(status) ? "AND status = ?" : ""} ORDER BY created_at DESC`)
      .all(eventId, ...(STATUSES.includes(status) ? [status] : []));
    const cols = columns(eventId, rows);
    const out = rows.map((g) => {
      const snapshot = new Map(json(g.fields, []).map((f) => [f.id, f]));
      const answers = json(g.answers, {});
      const shown = {};
      for (const c of cols) shown[c.id] = display(snapshot.get(c.id) || c, answers[c.id]);
      return {
        id: g.id,
        createdAt: g.created_at,
        status: g.status,
        language: g.language,
        email: g.email,
        formVersion: g.form_version,
        answers: shown,
        consent: json(g.consent, []),
      };
    });
    const filtered = q
      ? out.filter((g) => [g.email, g.language, g.status, ...Object.values(g.answers)].join(" ").toLowerCase().includes(q))
      : out;
    return { fields: cols.map((c) => ({ id: c.id, type: c.type, label: c.label, removed: Boolean(c.removed) })), rows: filtered, total: rows.length };
  }
  r.get(
    "/api/admin/events/:id/registrations",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      return query(ctx, e.id);
    },
    { perm: "registrations" },
  );
  r.get(
    "/api/admin/events/:id/registrations/export",
    (ctx) => {
      const e = load.event(ctx.user, ctx.params.id);
      const { fields, rows } = query(ctx, e.id);
      const w = exportWords(ctx.query.get("lang"));
      const header = [w.received, w.status, w.language, w.email, ...fields.map((f) => f.label), w.consent];
      const data = rows.map((g) => [
        g.createdAt,
        w[g.status] || g.status,
        g.language,
        g.email,
        ...fields.map((f) => (g.answers[f.id] === "Yes" ? w.yes : g.answers[f.id] === "No" ? w.no : g.answers[f.id])),
        g.consent.map((c) => c.at + " — " + c.text).join(" | "),
      ]);
      const format = ctx.query.get("format") === "xlsx" ? "xlsx" : "csv";
      const name = fileName(ctx.query.get("name") || e.reference + "_registrations", format);
      load.audit(ctx.user, e.tenant_id, "registrations.export", e.id, { format, rows: rows.length });
      const body = format === "xlsx" ? xlsx(header, data, w.registrations) : Buffer.from(csv(header, data), "utf8");
      ctx.res.writeHead(200, {
        "content-type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="' + name + '"',
        "cache-control": "no-store",
      });
      ctx.res.end(body);
    },
    { perm: "registrations" },
  );
  r.patch(
    "/api/admin/registrations/:id",
    (ctx) => {
      const { registration: g, event: e } = load.registration(ctx.user, ctx.params.id);
      const status = ctx.body.status;
      if (!STATUSES.includes(status)) fail(400, "Invalid request.");
      db.prepare("UPDATE registrations SET status = ? WHERE id = ?").run(status, g.id);
      load.audit(ctx.user, e.tenant_id, "registration.status", g.id, { status: [g.status, status] });
      return { id: g.id, status };
    },
    { perm: "registrations" },
  );
  r.delete(
    "/api/admin/registrations/:id",
    (ctx) => {
      const { registration: g, event: e } = load.registration(ctx.user, ctx.params.id);
      db.prepare("DELETE FROM registrations WHERE id = ?").run(g.id);
      load.audit(ctx.user, e.tenant_id, "registration.delete", g.id, { event: e.id, created: g.created_at });
    },
    { perm: "registrations" },
  );
};
