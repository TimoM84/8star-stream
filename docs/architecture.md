# Architecture

One Node.js process (no framework) with SQLite (`node:sqlite`, one file in the data volume, WAL mode).

```
server.js            start, stop on SIGTERM
src/app.js           configuration, HTTP server, security headers, routing, first administrator
src/db.js            schema and migrations
src/auth.js          sign-in, sessions (cookie + CSRF token), roles, environment scoping
src/phase.js         which phase a session shows
src/watch.js         public watch API (state, access code, registration, viewer beacon)
src/monitor.js       signal checks, usage minutes, viewer counting
src/providers/       provider definitions and the HLS playlist check
src/sanitize.js      HTML check (readable problems) and allow-list clean-up
src/forms.js         registration fields and answer validation
src/export.js        CSV and XLSX without extra packages
src/api/*.js         admin API per area
public/admin.html    admin (plain JavaScript, public/js/*)
public/watch.html    watch page (watch.js, hls.js from public/vendor)
```

## Data

- `tenants` — the platform and reseller environments. Every customer, user, event, media item and template belongs to one; every admin query goes through `canSee`/`scope`, and records outside the user's environment answer 404.
- `events` → `sessions`, `languages`; `variants` per session × language (active route, pre/after media, VOD); `routes` per session × language × slot (primary/backup).
- `pages` per event × phase × language with draft and published HTML.
- `forms` per event; `registrations` keep a copy of the fields they were made with, so they stay readable when the form changes.
- `usage_minutes` (route × minute, live or test, viewers, estimated GB), `viewer_stats` (peak, plays), `route_switches`, `audit`.

## Watch page

The page polls `GET /api/watch/<slug>/state` every ~6 s (with jitter). The answer is cached for 2 s per event, language, session and access state and is cleared on every admin change, so it stays cheap with many viewers; for public events it may also be cached for 3 s by a proxy or CDN. The stream itself goes from the provider to the viewer.

The answer only contains a playback URL when the session is publicly live, the event is not in test and the viewer has access. Access tokens: an HMAC over the event and the (hashed) access code — a new code invalidates old tokens — or a random registration token, stored only as a SHA-256 hash.

## Security

- Admin: `Content-Security-Policy` without inline scripts, `frame-ancestors 'self'`; session cookie `HttpOnly; SameSite=Strict`; a CSRF token on every change; same-origin check on every POST/PUT/PATCH/DELETE; sign-in limited to 10 failures per 15 minutes per address and account.
- Watch page: same script policy; `frame-src` limited to the event's chat and the approved iframe sources; embeddable according to `FRAME_ANCESTORS`.
- Page HTML: refused when it contains anything outside the allow-list, then cleaned with `sanitize-html`; variables are HTML-escaped.
- Uploads: PNG, JPG, WebP or GIF only, checked on content; served with `sandbox` CSP and `nosniff`.
- Passwords: scrypt. Stream keys are never written to the audit log and never shown to content managers.
