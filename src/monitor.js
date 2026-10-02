"use strict";
// Signal monitoring, usage minutes and viewer counts.
//
// Monitoring: every PROBE_SECONDS the routes of sessions that are (about to
// be) on air are probed. A minute in which a route had a signal is stored as
// a usage minute: "live" when the session is publicly live and the route is
// the active one, otherwise "test" (Green Room, pre-roll, standby backup).
// Data volume is estimated as viewers × route bitrate, until a provider API
// delivers measured values.
//
// Viewers: the watch page sends a beacon every 30 s while it plays; a viewer
// counts as watching for 70 s after the last beacon.
const { probe, forget } = require("./providers/probe");
const { providerOf } = require("./providers");
const { publicPhase } = require("./phase");
const { json } = require("./util");

const VIEWER_WINDOW_MS = 70000;

function createViewers(db, { maxViewers = 1_000_000 } = {}) {
  const beats = new Map(); // viewerId → { event, session, language, at }
  const counted = new Set(); // viewerId|session|language that counted as a play
  const upsert = db.prepare(`
    INSERT INTO viewer_stats (event_id, session_id, language_id, peak, peak_at, plays)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, session_id, language_id) DO UPDATE SET
      plays = plays + excluded.plays,
      peak_at = CASE WHEN excluded.peak > peak THEN excluded.peak_at ELSE peak_at END,
      peak = MAX(peak, excluded.peak)`);
  let newPlays = new Map();
  function beat(viewerId, eventId, sessionId, languageId) {
    if (!viewerId || (beats.size >= maxViewers && !beats.has(viewerId))) return false;
    beats.set(viewerId, { event: eventId, session: sessionId, language: languageId, at: Date.now() });
    const k = viewerId + "|" + sessionId + "|" + languageId;
    if (!counted.has(k)) {
      counted.add(k);
      const key = eventId + "|" + sessionId + "|" + languageId;
      newPlays.set(key, (newPlays.get(key) || 0) + 1);
    }
    return true;
  }
  // Current viewers, optionally for one session and/or language.
  function current(eventId, sessionId, languageId) {
    const since = Date.now() - VIEWER_WINDOW_MS;
    let n = 0;
    for (const b of beats.values())
      if (b.at >= since && b.event === eventId && (!sessionId || b.session === sessionId) && (!languageId || b.language === languageId)) n++;
    return n;
  }
  function byKey() {
    const since = Date.now() - VIEWER_WINDOW_MS,
      out = new Map();
    for (const b of beats.values())
      if (b.at >= since) {
        const key = b.event + "|" + b.session + "|" + b.language;
        out.set(key, (out.get(key) || 0) + 1);
      }
    return out;
  }
  // Once a minute: peaks and plays to the database, forget old viewers.
  function flush() {
    const counts = byKey(),
      at = new Date().toISOString(),
      keys = new Set([...counts.keys(), ...newPlays.keys()]);
    for (const key of keys) {
      const [e, s, l] = key.split("|");
      upsert.run(e, s, l, counts.get(key) || 0, at, newPlays.get(key) || 0);
    }
    newPlays = new Map();
    const old = Date.now() - 10 * 60000;
    for (const [id, b] of beats) if (b.at < old) beats.delete(id);
    if (counted.size > 2 * maxViewers) counted.clear();
    return counts;
  }
  return { beat, current, byKey, flush };
}

function createMonitor(db, { viewers, probeSeconds = 10, audit = () => {}, onSignalChange = () => {} } = {}) {
  const routesToWatch = db.prepare(`
    SELECT r.*, s.start_at, s.end_at, s.phase_override, s.event_id, e.status AS event_status, e.tenant_id
    FROM routes r
    JOIN sessions s ON s.id = r.session_id
    JOIN events e ON e.id = s.event_id
    WHERE e.status IN ('draft','test','scheduled')
      AND (e.status = 'test' OR s.phase_override = 'live'
           OR (julianday(s.start_at) - 3.0/24 <= julianday('now') AND julianday('now') <= julianday(s.end_at) + 1.0/24))`);
  const setSignal = db.prepare("UPDATE routes SET signal = ?, signal_detail = ?, signal_checked_at = ?, signal_changed_at = COALESCE(?, signal_changed_at) WHERE id = ?");
  const variantOf = db.prepare("SELECT * FROM variants WHERE session_id = ? AND language_id = ?");
  const sessionOf = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const eventOf = db.prepare("SELECT * FROM events WHERE id = ?");
  const insertMinute = db.prepare(`
    INSERT OR IGNORE INTO usage_minutes (route_id, event_id, session_id, language_id, slot, kind, minute, viewers, gb_estimate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seen = new Map(); // routeId → Set of minutes (ISO, seconds cut) with a signal
  let running = false;

  const minuteOf = (t) => new Date(Math.floor(t / 60000) * 60000).toISOString();

  async function probeAll() {
    if (running) return;
    running = true;
    try {
      const routes = routesToWatch.all();
      const queue = [...routes];
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          const url = providerOf(r.provider).describe(json(r.config, {})).playbackUrl;
          const res = await probe(r.id, url);
          const t = new Date().toISOString();
          const changed = res.signal !== r.signal;
          setSignal.run(res.signal, res.detail, t, changed ? t : null, r.id);
          if (changed) onSignalChange({ ...r, signal: res.signal, detail: res.detail, previous: r.signal });
          if (res.signal === "ok") {
            if (!seen.has(r.id)) seen.set(r.id, new Set());
            seen.get(r.id).add(minuteOf(Date.now()));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
    } finally {
      running = false;
    }
  }

  // Store every finished minute in which a route had a signal.
  function flushMinutes(force = false) {
    const thisMinute = minuteOf(Date.now());
    for (const [routeId, minutes] of seen) {
      const route = db.prepare("SELECT * FROM routes WHERE id = ?").get(routeId);
      if (!route) {
        seen.delete(routeId);
        continue;
      }
      const session = sessionOf.get(route.session_id),
        event = session && eventOf.get(session.event_id),
        variant = variantOf.get(route.session_id, route.language_id);
      for (const minute of [...minutes]) {
        if (minute >= thisMinute && !force) continue;
        minutes.delete(minute);
        if (!session || !event) continue;
        const t = Date.parse(minute) + 30000;
        const live = event.status !== "test" && publicPhase(session, event, variant, t) === "live" && route.slot === (variant?.active_slot || "primary");
        const n = live && viewers ? viewers.current(event.id, session.id, route.language_id) : 0;
        const gb = (n * route.bitrate_kbps * 1000 * 60) / 8 / 1e9;
        insertMinute.run(route.id, event.id, session.id, route.language_id, route.slot, live ? "live" : "test", minute, n, gb);
      }
      if (!minutes.size) seen.delete(routeId);
    }
  }

  const timers = [];
  function start() {
    timers.push(setInterval(probeAll, probeSeconds * 1000));
    timers.push(
      setInterval(() => {
        flushMinutes();
        viewers?.flush();
      }, 15000),
    );
    for (const t of timers) t.unref();
    probeAll();
  }
  function stop() {
    for (const t of timers) clearInterval(t);
    flushMinutes(true);
  }
  return { start, stop, probeAll, flushMinutes, forget };
}

module.exports = { createMonitor, createViewers };
