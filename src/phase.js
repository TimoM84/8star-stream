"use strict";
// Which phase the watch page shows: pre → live → after → vod.
//
//  - Event in "draft" or "test": the public page always shows the pre phase
//    (in test the technician checks the real streams in the Green Room).
//  - Event "scheduled": a manual phase set on a session wins over the
//    schedule; otherwise before start "pre", between start and end "live",
//    after the end "after".
//  - Event "archived": never live; "after" or "vod".
//  - "after" becomes "vod" per language as soon as that language's VOD is
//    published and available (publication date reached, not expired).
const json = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s || {};
  } catch {
    return {};
  }
};

function schedulePhase(session, event, t = Date.now()) {
  if (event.status === "draft" || event.status === "test") return "pre";
  if (event.status === "archived") return session.phase_override === "vod" ? "vod" : "after";
  if (session.phase_override) return session.phase_override;
  if (t < Date.parse(session.start_at)) return "pre";
  if (t < Date.parse(session.end_at)) return "live";
  return "after";
}
function vodAvailable(vod, t = Date.now()) {
  const v = json(vod);
  if (!v.url || !v.published) return false;
  if (v.publishAt && t < Date.parse(v.publishAt)) return false;
  if (!v.unlimited && v.expireAt && t >= Date.parse(v.expireAt)) return false;
  return true;
}
function publicPhase(session, event, variant, t = Date.now()) {
  const base = schedulePhase(session, event, t);
  if (base === "after" || base === "vod") return vodAvailable(variant?.vod, t) ? "vod" : "after";
  return base;
}

module.exports = { schedulePhase, publicPhase, vodAvailable, PHASES: ["pre", "live", "after", "vod"] };
