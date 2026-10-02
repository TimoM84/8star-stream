"use strict";
// Streaming providers. The platform is provider-agnostic: every route has a
// playback URL (HLS) that viewers play and that the platform watches for a
// signal, and ingest details that the technician enters into the encoder.
// A provider only knows how to fill in those details from its own settings.
//
// Adding a provider: add an entry with `fields` (shown in the stream
// settings) and `describe(config)` returning { ingestUrl, streamKey,
// playbackUrl }. Optional: `usage(route, config)` for measured data volume
// from the provider's API (not used yet; the platform estimates GB from
// viewers × bitrate).
const trim = (s) => String(s || "").trim();
const join = (base, ...parts) =>
  [trim(base).replace(/\/+$/, ""), ...parts.map((p) => trim(p).replace(/^\/+|\/+$/g, ""))].filter(Boolean).join("/");

const PROVIDERS = {
  hls: {
    label: "Any provider (ingest and HLS playback URL)",
    fields: [
      { key: "ingestUrl", label: "Ingest URL (RTMP, RTMPS or SRT)" },
      { key: "streamKey", label: "Stream key", secret: true },
      { key: "playbackUrl", label: "Playback URL (HLS .m3u8)" },
    ],
    describe: (c) => ({ ingestUrl: trim(c.ingestUrl), streamKey: trim(c.streamKey), playbackUrl: trim(c.playbackUrl) }),
  },
  wowza: {
    label: "Wowza Streaming Engine",
    fields: [
      { key: "ingestHost", label: "Ingest host (e.g. rtmp://wowza.example.com:1935)" },
      { key: "playbackHost", label: "Playback host (e.g. https://wowza.example.com)" },
      { key: "application", label: "Application (e.g. live)" },
      { key: "streamName", label: "Stream name" },
    ],
    describe: (c) => ({
      ingestUrl: join(c.ingestHost, c.application),
      streamKey: trim(c.streamName),
      playbackUrl: c.playbackHost && c.application && c.streamName ? join(c.playbackHost, c.application, c.streamName, "playlist.m3u8") : "",
    }),
  },
  mediamtx: {
    label: "MediaMTX (self-hosted)",
    fields: [
      { key: "ingestHost", label: "Ingest host (e.g. rtmp://stream.example.com:1935)" },
      { key: "playbackHost", label: "HLS host (e.g. https://stream.example.com:8888)" },
      { key: "path", label: "Path (e.g. event/nl)" },
    ],
    describe: (c) => ({
      ingestUrl: join(c.ingestHost),
      streamKey: trim(c.path),
      playbackUrl: c.playbackHost && c.path ? join(c.playbackHost, c.path, "index.m3u8") : "",
    }),
  },
};

const providerOf = (id) => PROVIDERS[id] || PROVIDERS.hls;
// Public description for the stream settings screen.
const catalog = () =>
  Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, fields: p.fields.map(({ key, label, secret }) => ({ key, label, secret: Boolean(secret) })) }));

module.exports = { PROVIDERS, providerOf, catalog };
