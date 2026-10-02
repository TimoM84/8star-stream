"use strict";
// Shared lookups for the admin API. Every tenant-owned record is loaded
// through these helpers, which answer 404 for records outside the user's
// environment (so a reseller cannot even learn that they exist).
const { fail } = require("../http");
const { canSee } = require("../auth");
const { json, now } = require("../util");
const { providerOf } = require("../providers");

function loaders(db) {
  const q = {
    event: db.prepare("SELECT * FROM events WHERE id = ?"),
    session: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    language: db.prepare("SELECT * FROM languages WHERE id = ?"),
    route: db.prepare("SELECT * FROM routes WHERE id = ?"),
    customer: db.prepare("SELECT * FROM customers WHERE id = ?"),
    contact: db.prepare("SELECT * FROM contacts WHERE id = ?"),
    user: db.prepare("SELECT * FROM users WHERE id = ?"),
    tenant: db.prepare("SELECT * FROM tenants WHERE id = ?"),
    template: db.prepare("SELECT * FROM templates WHERE id = ?"),
    media: db.prepare("SELECT * FROM media WHERE id = ?"),
    registration: db.prepare("SELECT * FROM registrations WHERE id = ?"),
    insertAudit: db.prepare(
      "INSERT INTO audit (tenant_id, user_id, user_email, action, target, detail, result, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
  };
  const visible = (user, row, tenantId) => {
    if (!row || !canSee(user, tenantId)) fail(404, "Not found.");
    return row;
  };
  const event = (user, id) => {
    const e = q.event.get(String(id));
    return visible(user, e, e?.tenant_id);
  };
  const session = (user, id) => {
    const s = q.session.get(String(id));
    if (!s) fail(404, "Not found.");
    return { session: s, event: event(user, s.event_id) };
  };
  const language = (user, id) => {
    const l = q.language.get(String(id));
    if (!l) fail(404, "Not found.");
    return { language: l, event: event(user, l.event_id) };
  };
  // A session and a language of the same event.
  const sessionLanguage = (user, sessionId, languageId) => {
    const { session: s, event: e } = session(user, sessionId);
    const l = q.language.get(String(languageId));
    if (!l || l.event_id !== e.id) fail(404, "Not found.");
    return { session: s, language: l, event: e };
  };
  const route = (user, id) => {
    const r = q.route.get(String(id));
    if (!r) fail(404, "Not found.");
    return { route: r, ...session(user, r.session_id) };
  };
  const customer = (user, id) => {
    const c = q.customer.get(String(id));
    return visible(user, c, c?.tenant_id);
  };
  const contact = (user, id) => {
    const c = q.contact.get(String(id));
    if (!c) fail(404, "Not found.");
    return { contact: c, customer: customer(user, c.customer_id) };
  };
  const userRow = (user, id) => {
    const u = q.user.get(String(id));
    return visible(user, u, u?.tenant_id);
  };
  const tenant = (user, id) => {
    const t = q.tenant.get(String(id));
    return visible(user, t, t?.id);
  };
  // Central templates (tenant_id NULL) are visible to everyone.
  const template = (user, id) => {
    const t = q.template.get(String(id));
    if (!t || (t.tenant_id && !canSee(user, t.tenant_id))) fail(404, "Not found.");
    return t;
  };
  const media = (user, id) => {
    const m = q.media.get(String(id));
    return visible(user, m, m?.tenant_id);
  };
  const registration = (user, id) => {
    const r = q.registration.get(String(id));
    if (!r) fail(404, "Not found.");
    return { registration: r, event: event(user, r.event_id) };
  };
  // The environment a new record belongs to: a reseller always its own; the
  // platform may choose (default: its own).
  const targetTenant = (user, requested) => {
    if (!user.platform || !requested) return user.tenantId;
    const t = q.tenant.get(String(requested));
    if (!t) fail(400, "Unknown environment.");
    if (t.status !== "active") fail(400, "This environment is not active.");
    return t.id;
  };
  // Audit line: who did what, to what, with old and new values where useful.
  const audit = (user, tenantId, action, target = "", detail = {}, result = "ok") =>
    q.insertAudit.run(
      tenantId ?? user?.tenantId ?? null,
      user?.id ?? null,
      user?.email ?? "system",
      action,
      String(target),
      JSON.stringify(detail),
      result,
      now(),
    );
  return {
    event,
    session,
    language,
    sessionLanguage,
    route,
    customer,
    contact,
    user: userRow,
    tenant,
    template,
    media,
    registration,
    targetTenant,
    audit,
  };
}

// Changed fields between two plain objects, as { field: [old, new] }.
function diff(before, after, keys) {
  const out = {};
  for (const k of keys) {
    const a = before[k],
      b = after[k];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b];
  }
  return out;
}

// Route as shown in the admin. Ingest and playback details and secret
// fields are only shown to users who manage streams (Green Room access).
function routeOut(r, withSecrets) {
  const provider = providerOf(r.provider),
    config = json(r.config, {}),
    d = provider.describe(config);
  if (!withSecrets) {
    for (const f of provider.fields) if (f.secret && config[f.key]) config[f.key] = "••••••";
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    languageId: r.language_id,
    slot: r.slot,
    provider: r.provider,
    config: withSecrets ? config : {},
    bitrateKbps: r.bitrate_kbps,
    playbackUrl: withSecrets ? d.playbackUrl : "",
    configured: Boolean(d.playbackUrl),
    ingestUrl: withSecrets ? d.ingestUrl : "",
    streamKey: withSecrets ? d.streamKey : "",
    signal: r.signal,
    signalDetail: r.signal_detail,
    signalCheckedAt: r.signal_checked_at,
    signalChangedAt: r.signal_changed_at,
  };
}

module.exports = { loaders, diff, routeOut };
