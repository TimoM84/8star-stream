# Changelog

## 0.2.0 — new player

- Own player controls: LIVE badge and "go to live", seek bar, volume, speed, quality (when the stream has several), full screen, keyboard and touch
- Language choice inside the player; the player stays in full screen when the language changes
- Subtitles for recordings: WebVTT or SRT per language (up to 12 tracks), uploaded in the admin and shown by the player; the viewer's choice is remembered
- Subtitle tracks that an HLS stream contains are listed too (not tested with a real stream)

## 0.1.0 — first version ("core first")

First version of the livestream platform, built from the NFGD requirements (Streaming Manager, version 1.0). Covers the core of priority 1:

- Environments for NFGD and resellers (create, block, archive), customers with contacts, account manager and default branding, users with three roles
- Events with automatic, editable project reference, permanent watch link and embed code, days, sessions and rooms, copying of events and sessions
- Phases by schedule or by hand; Test status with Green Room
- Languages with their own streams, media, page texts and VOD; switching without reloading; direct language links; copying a language
- Primary and backup routes per session and language, provider-agnostic (any HLS provider, Wowza, MediaMTX); signal monitoring; manual switch with confirmation, reason and log; visible and audible alarm
- Watch page editor (visual and HTML), media library, variables, templates, draft and publish per phase and language, preview on desktop and mobile, branding, HTML check with approved iframe sources
- Access: public, access code or registration; registration form builder, approval, consent record, search and CSV/Excel export
- After live media and VOD with start and end point, chapters, publication and expiry date
- Usage: live, language stream and test minutes, estimated GB, viewers (current, peak, plays), CSV/Excel export
- Dashboard and audit log

Not yet included: see "Not in this version yet" in the README.
