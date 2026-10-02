"use strict";
// Signal detection that works with any provider: read the route's HLS
// playlist and check that new segments keep appearing.
//
//   ok       playlist reachable and the media sequence advanced recently (or
//            this is the first look and it has segments)
//   lost     unreachable, an error status, no segments, the stream ended
//            (#EXT-X-ENDLIST) or no new segment for a while (stalled)
//   unknown  no playback URL configured
const memory = new Map(); // routeId → { seq, segment, changedAt }

const lines = (text) =>
  String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

async function fetchText(url, timeoutMs) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow", headers: { "user-agent": "8star-stream-monitor" } });
  if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { code: "HTTP" });
  return { text: await r.text(), url: r.url || url };
}

async function probe(routeId, playbackUrl, { timeoutMs = 4000, now = Date.now() } = {}) {
  if (!playbackUrl) return { signal: "unknown", detail: "No playback URL" };
  let doc;
  try {
    doc = await fetchText(playbackUrl, timeoutMs);
    let ls = lines(doc.text);
    if (ls[0] !== "#EXTM3U") return { signal: "lost", detail: "Not an HLS playlist" };
    // Master playlist: follow the first variant.
    const variantIndex = ls.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    if (variantIndex !== -1) {
      const uri = ls.slice(variantIndex + 1).find((l) => !l.startsWith("#"));
      if (!uri) return { signal: "lost", detail: "Empty master playlist" };
      doc = await fetchText(new URL(uri, doc.url).href, timeoutMs);
      ls = lines(doc.text);
    }
    if (ls.includes("#EXT-X-ENDLIST")) return { signal: "lost", detail: "Stream ended" };
    const segments = ls.filter((l) => !l.startsWith("#"));
    if (!segments.length) return { signal: "lost", detail: "No segments" };
    const seq = Number((ls.find((l) => l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) || "").split(":")[1] || 0);
    const target = Number((ls.find((l) => l.startsWith("#EXT-X-TARGETDURATION:")) || "").split(":")[1] || 6);
    const last = segments.at(-1),
      prev = memory.get(routeId);
    const changed = !prev || prev.seq !== seq || prev.segment !== last;
    const state = { seq, segment: last, changedAt: changed ? now : prev.changedAt };
    memory.set(routeId, state);
    // No new segment for three target durations (at least 20 s): stalled.
    if (now - state.changedAt > Math.max(20000, 3 * target * 1000))
      return { signal: "lost", detail: "No new video for " + Math.round((now - state.changedAt) / 1000) + " s" };
    return { signal: "ok", detail: "" };
  } catch (e) {
    return { signal: "lost", detail: e.name === "TimeoutError" ? "No answer" : e.message || "Unreachable" };
  }
}
const forget = (routeId) => memory.delete(routeId);

module.exports = { probe, forget };
