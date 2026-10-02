// Watch page: one permanent link per event. Shows the pre phase, the live
// stream, after live and the VOD; the viewer chooses a language without
// leaving the page. The page asks the server for the current state every
// few seconds, so phase, route and language changes arrive by themselves.
"use strict";
(function () {
  const slug = (location.pathname.match(/^\/w\/([a-z0-9-]+)/) || [])[1] || "";
  const params = new URLSearchParams(location.search);
  const preview = params.get("preview") === "1";
  const embed = params.get("embed") === "1";
  if (embed) document.documentElement.classList.add("embed");

  // ---- Storage that may be unavailable (private mode, blocked iframes) ----
  const memory = {};
  const store = (kind) => ({
    get(k) {
      try {
        return window[kind].getItem(k) ?? memory[kind + k] ?? null;
      } catch {
        return memory[kind + k] ?? null;
      }
    },
    set(k, v) {
      memory[kind + k] = v;
      try {
        window[kind].setItem(k, v);
      } catch {}
    },
  });
  const local = store("localStorage"),
    session = store("sessionStorage");
  const accessKey = "8ss-access-" + slug,
    langKey = "8ss-lang-" + slug;
  let accessToken = local.get(accessKey) || "";
  let viewerId = session.get("8ss-viewer");
  if (!viewerId) {
    viewerId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    session.set("8ss-viewer", viewerId);
  }

  // ---- State ------------------------------------------------------------------
  let lang = params.get("lang") || session.get(langKey) || "";
  let sessionId = params.get("session") || "";
  let st = null;
  let ui = "en";
  const t = (s, vars) => {
    let out = window.I18N?.watch?.[ui]?.[s] || s;
    if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
    return out;
  };

  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const $ = (id) => document.getElementById(id);
  const clear = (el) => {
    while (el.firstChild) el.firstChild.remove();
    return el;
  };
  // Appends children: arrays flattened, empty values skipped.
  const add = (el, ...children) => {
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };

  async function fetchState() {
    const q = new URLSearchParams();
    if (lang) q.set("lang", lang);
    if (sessionId) q.set("session", sessionId);
    if (preview) {
      q.set("preview", "1");
      if (params.get("phase")) q.set("phase", params.get("phase"));
    }
    const res = await fetch("/api/watch/" + slug + "/state?" + q, { headers: accessToken ? { "x-access": accessToken } : {}, credentials: "same-origin" });
    if (res.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
    if (!res.ok) throw new Error("state " + res.status);
    return res.json();
  }

  // ---- Player -----------------------------------------------------------------
  const video = h("video", { id: "video", controls: true, playsinline: true, preload: "auto" });
  let current = { url: "", kind: "" };
  let hls = null;
  let trim = { start: null, end: null };
  let retryTimer = null;
  // Signal of the active live route as reported by the server.
  let lastSignal = "";
  // Clears the "back in a moment" message, unless the server still reports
  // that the encoder signal is gone.
  const clearOverlay = () => {
    if (lastSignal !== "lost") setOverlay("");
  };
  function setOverlay(text) {
    const o = $("overlay");
    if (!o) return;
    o.hidden = !text;
    o.textContent = text || "";
  }
  function play(url, kind, opts = {}, force = false) {
    if (!force && current.url === url && current.kind === kind) return;
    current = { url, kind };
    if (hls) {
      hls.destroy();
      hls = null;
    }
    clearTimeout(retryTimer);
    clearOverlay();
    if (!url) {
      video.removeAttribute("src");
      video.load();
      return;
    }
    trim = { start: opts.trimStart ?? null, end: opts.trimEnd ?? null };
    video.loop = Boolean(opts.loop);
    video.muted = Boolean(opts.muted);
    if (opts.poster) video.poster = opts.poster;
    else video.removeAttribute("poster");
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && window.Hls && window.Hls.isSupported()) {
      // Live: start at the live position (a few segments behind the edge).
      hls = new window.Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
      hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
        setOverlay(kind === "live" ? t("The broadcast will be back in a moment…") : t("The video cannot be loaded right now."));
        retryTimer = setTimeout(() => {
          if (hls) {
            hls.stopLoad();
            hls.loadSource(url);
            hls.startLoad();
          }
        }, 4000);
      });
      hls.on(window.Hls.Events.FRAG_LOADED, () => clearOverlay());
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
    }
    if (opts.autoplay !== false) video.play().catch(() => {});
  }
  video.addEventListener("loadedmetadata", () => {
    if (trim.start && video.currentTime < trim.start) video.currentTime = trim.start;
  });
  video.addEventListener("timeupdate", () => {
    if (trim.start && video.currentTime < trim.start - 0.5) video.currentTime = trim.start;
    if (trim.end && video.currentTime >= trim.end) {
      video.pause();
      video.currentTime = trim.end;
    }
  });
  video.addEventListener("playing", () => clearOverlay());
  // Live watchdog: when the picture stands still (encoder restarted, network
  // hiccup) the player starts again at the live position.
  let lastTime = -1,
    stillSince = 0;
  setInterval(() => {
    if (current.kind !== "live" || video.paused) return (stillSince = 0);
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      stillSince = Date.now();
      return;
    }
    if (stillSince && Date.now() - stillSince > 15000) {
      stillSince = Date.now();
      setOverlay(t("The broadcast will be back in a moment…"));
      // While the encoder is gone a restart is pointless; the player starts
      // again when the signal returns.
      if (lastSignal !== "lost") play(current.url, "live", { autoplay: true }, true);
    }
  }, 5000);
  video.addEventListener("error", () => {
    if (current.url) setOverlay(current.kind === "live" ? t("The broadcast will be back in a moment…") : t("The video cannot be loaded right now."));
  });

  // ---- Rendering --------------------------------------------------------------
  let lastHtml = null,
    lastChat = null,
    lastStage = "",
    lastForm = "";
  function applyBranding(b, title) {
    const root = document.documentElement.style;
    if (b.primary) root.setProperty("--accent", b.primary);
    if (b.backgroundColor) root.setProperty("--bg", b.backgroundColor);
    if (b.text) root.setProperty("--text", b.text);
    document.body.style.backgroundImage = b.background ? 'url("' + b.background.replace(/["\\]/g, "") + '")' : "";
    document.body.classList.toggle("has-bg", Boolean(b.background));
    document.title = title;
  }
  function render() {
    const s = st;
    ui = window.I18N?.watch?.[s.language.slice(0, 2)] ? s.language.slice(0, 2) : "en";
    document.documentElement.lang = s.language || "en";
    const b = s.event.branding || {};
    const title = b.title || s.event.title;
    applyBranding(b, title);

    // Header: logo, title, language choice.
    const head = clear($("head"));
    add(head, 
      h("div", { class: "w-brand" }, b.logo ? h("img", { class: "w-logo", src: b.logo, alt: "" }) : null, h("h1", { text: title })),
      s.languages.length > 1
        ? h(
            "nav",
            { class: "w-langs", "aria-label": t("Language") },
            s.languages.map((l) =>
              h("button", { type: "button", lang: l.code, "aria-pressed": String(l.code === s.language), onclick: () => switchLanguage(l.code) }, l.name),
            ),
          )
        : null,
    );
    if (preview) add(head, h("div", { class: "w-preview", text: t("Preview — draft content, not visible to viewers") }));

    // Notices: language not available.
    const notes = clear($("notes"));
    if (s.languageUnavailable) add(notes, h("p", { class: "w-note", role: "status" }, t("The chosen language is not available. You are watching in {language}.", { language: s.languages.find((l) => l.code === s.language)?.name || s.language })));

    // Sessions (several rooms or days).
    const tabs = clear($("sessions"));
    if (s.sessions.length > 1) {
      add(tabs, 
        h(
          "nav",
          { class: "w-sessions", "aria-label": t("Programme") },
          s.sessions.map((x) =>
            h(
              "button",
              { type: "button", "aria-pressed": String(x.id === s.session), onclick: () => switchSession(x.id) },
              x.phase === "live" ? h("span", { class: "dot", "aria-label": t("Live") }) : null,
              h("strong", { text: x.title }),
              h("small", { text: fmtWhen(x) + (x.room ? " · " + x.room : "") }),
            ),
          ),
        ),
      );
    }

    renderStage();
    renderChat();

    // Page content (published HTML, checked by the server).
    if (s.html !== lastHtml) {
      $("content").innerHTML = s.html || "";
      lastHtml = s.html;
    }
    renderChapters();
    renderForm();
  }
  const fmtWhen = (x) => {
    try {
      const d = new Date(x.startAt);
      return d.toLocaleDateString(st.language, { weekday: "short", day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(st.language, { hour: "2-digit", minute: "2-digit" });
    } catch {
      return x.startAt.slice(0, 16).replace("T", " ");
    }
  };

  function renderStage() {
    const s = st;
    // Signal of the active route: overlay while it is gone, fresh start of
    // the player as soon as it is back.
    const signal = s.phase === "live" && s.access.granted ? s.stream?.signal || "" : "";
    if (signal !== lastSignal) {
      if (signal === "lost") setOverlay(t("The broadcast will be back in a moment…"));
      else if (lastSignal === "lost" && signal === "ok" && current.kind === "live") play(current.url, "live", { autoplay: true }, true);
      lastSignal = signal;
    }
    const stage = $("stage");
    const key = [s.phase, s.access.granted, s.access.status, s.stream?.url, s.vod?.url, s.media?.url, s.streamUnavailable, s.session, s.language].join("|");
    if (key === lastStage) return;
    lastStage = key;
    const frame = h("div", { class: "w-player" }, video, h("div", { id: "overlay", class: "w-overlay", hidden: true, role: "status" }));
    if (!s.access.granted) {
      play("", "");
      add(clear(stage), placeholder(), accessPanel());
      return;
    }
    if (s.phase === "live") {
      if (s.stream) {
        add(clear(stage), frame);
        play(s.stream.url, "live", { autoplay: true });
        if (s.stream.signal === "lost") setOverlay(t("The broadcast will be back in a moment…"));
      } else {
        play("", "");
        const def = s.languages.find((l) => l.default);
        add(clear(stage), 
          h(
            "div",
            { class: "w-placeholder" },
            h("p", { text: preview ? t("Preview: the stream itself is only shown in the Green Room.") : t("This language is temporarily unavailable.") }),
            !preview && def && def.code !== s.language ? h("button", { type: "button", class: "w-primary", onclick: () => switchLanguage(def.code) }, t("Watch in {language}", { language: def.name })) : null,
          ),
        );
      }
      return;
    }
    if (s.phase === "vod" && s.vod?.url) {
      add(clear(stage), frame);
      play(s.vod.url, "vod", { trimStart: s.vod.trimStart, trimEnd: s.vod.trimEnd, autoplay: false });
      return;
    }
    // Pre or after: image, video or waiting screen.
    if (s.media?.kind === "video") {
      add(clear(stage), frame);
      play(s.media.url, "media", { loop: s.media.loop, poster: s.media.poster, autoplay: false });
    } else {
      play("", "");
      add(clear(stage), placeholder());
    }
  }
  function placeholder() {
    const s = st;
    if (s.media?.kind === "image") return h("div", { class: "w-still" }, h("img", { src: s.media.url, alt: "" }));
    const cur = s.sessions.find((x) => x.id === s.session);
    const text = {
      pre: cur ? t("The broadcast starts on {when}.", { when: fmtWhen(cur) }) : t("The broadcast has not started yet."),
      live: t("The broadcast is live."),
      after: t("The broadcast has ended. Thank you for watching."),
      vod: t("The recording is available."),
    }[s.phase];
    return h("div", { class: "w-placeholder" }, h("p", { class: "w-big", text }));
  }

  // Access code or registration before the stream.
  function accessPanel() {
    const s = st;
    const box = h("div", { class: "w-access" });
    if (s.access.kind === "code") {
      const inp = h("input", { id: "access-code", name: "code", autocomplete: "off", required: true });
      const err = h("p", { class: "field-error", role: "alert", hidden: true });
      add(box, 
        h(
          "form",
          {
            class: "w-code",
            onsubmit: async (e) => {
              e.preventDefault();
              err.hidden = true;
              const res = await post("/code", { code: inp.value });
              if (res.ok) {
                accessToken = res.data.token;
                local.set(accessKey, accessToken);
                refresh(true);
              } else {
                err.textContent = t(res.data.error || "This access code is not correct.");
                err.hidden = false;
              }
            },
          },
          h("h2", { text: t("Access code") }),
          h("label", { for: "access-code", text: t("Enter the access code you received.") }),
          h("div", { class: "w-row" }, inp, h("button", { type: "submit", class: "w-primary" }, t("Watch"))),
          err,
        ),
      );
    } else if (s.access.kind === "registration") {
      if (s.access.status === "pending") add(box, h("h2", { text: t("Registration received") }), h("p", { text: lastMessage || t("Your registration is waiting for approval. This page opens automatically once it has been approved.") }));
      else if (s.access.status === "rejected") add(box, h("h2", { text: t("Registration not approved") }), h("p", { text: t("Your registration has not been approved. Please contact the organiser.") }));
      else add(box, h("p", { text: t("Register below to watch.") }), h("a", { href: "#register", class: "w-primary" }, t("Register")));
    }
    return box;
  }

  function renderChat() {
    const s = st;
    const aside = $("chat");
    const url = s.chat?.url || null;
    document.body.classList.toggle("with-chat", Boolean(url));
    if (url === lastChat) return;
    lastChat = url;
    clear(aside);
    if (url) add(aside, h("iframe", { src: url, title: t("Chat"), allow: "clipboard-write", loading: "lazy" }));
  }

  function renderChapters() {
    const box = clear($("chapters"));
    const list = st.phase === "vod" ? st.vod?.chapters || [] : [];
    if (!list.length || !st.access.granted) return;
    add(box, 
      h("h2", { text: t("Chapters") }),
      h(
        "ol",
        {},
        list.map((c) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                onclick: () => {
                  video.currentTime = c.time;
                  video.play().catch(() => {});
                },
              },
              h("span", { class: "time", text: clock(c.time) }),
              " ",
              c.title,
            ),
          ),
        ),
      ),
    );
  }
  const clock = (sec) => {
    const s = Math.floor(sec % 60),
      m = Math.floor((sec / 60) % 60),
      hh = Math.floor(sec / 3600);
    return (hh ? hh + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };

  // Registration form (required for access, or optional sign-up).
  let lastMessage = "";
  let registered = local.get("8ss-registered-" + slug) === "1";
  function renderForm() {
    const s = st;
    const box = $("register");
    const form = s.form && !(registered && !s.form.required) ? s.form : null;
    const key = form ? JSON.stringify(form) + s.language : registered ? "done" + s.access.kind : "";
    if (key === lastForm) return;
    lastForm = key;
    clear(box);
    if (!form) {
      // Thank-you message for an optional sign-up; with required
      // registration the player area shows the status instead.
      if (registered && lastMessage && s.access.kind !== "registration") add(box, h("div", { class: "reg-card done", role: "status" }, h("p", { text: lastMessage })));
      return;
    }
    const rf = window.RegForm.render(form, { t, idPrefix: "reg" });
    const err = h("p", { class: "field-error", role: "alert", hidden: true });
    const btn = h("button", { type: "submit", class: "w-primary" }, form.submit || t("Register"));
    add(box, 
      h(
        "form",
        {
          class: "reg-card",
          novalidate: true,
          onsubmit: async (e) => {
            e.preventDefault();
            err.hidden = true;
            btn.disabled = true;
            const res = await post("/register", { answers: rf.values(), language: s.language, session: s.session, website: rf.honeypot() });
            btn.disabled = false;
            if (res.status === 422 && res.data.errors) {
              rf.showErrors(res.data.errors);
              err.textContent = t(res.data.error);
              err.hidden = false;
              return;
            }
            if (!res.ok) {
              err.textContent = t(res.data.error || "Something went wrong. Please try again.");
              err.hidden = false;
              return;
            }
            lastMessage = res.data.message || (res.data.status === "pending" ? t("Thank you. Your registration is waiting for approval.") : t("Thank you for registering."));
            registered = true;
            local.set("8ss-registered-" + slug, "1");
            if (res.data.token && s.form.required) {
              accessToken = res.data.token;
              local.set(accessKey, accessToken);
            }
            lastForm = "";
            refresh(true);
          },
        },
        h("h2", { text: t("Registration") }),
        rf.el,
        err,
        btn,
      ),
    );
  }

  async function post(path, body) {
    try {
      const res = await fetch("/api/watch/" + slug + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "No connection. Please try again." } };
    }
  }

  // ---- Switching language and session without reloading ------------------------
  function switchLanguage(code) {
    lang = code;
    session.set(langKey, code);
    const u = new URL(location.href);
    u.searchParams.set("lang", code);
    history.replaceState(null, "", u);
    refresh(true);
  }
  function switchSession(id) {
    sessionId = id;
    const u = new URL(location.href);
    u.searchParams.set("session", id);
    history.replaceState(null, "", u);
    refresh(true);
  }

  // ---- Polling and viewer beacons -------------------------------------------------
  let timer = null;
  let failures = 0;
  async function refresh(now) {
    clearTimeout(timer);
    try {
      const next = await fetchState();
      failures = 0;
      // A stored access token that no longer works (new code) is forgotten.
      if (st && !next.access.granted && st.access.granted && next.access.kind === "code") local.set(accessKey, "");
      st = next;
      if (!lang) lang = st.language;
      render();
    } catch (e) {
      if (e.notFound) {
        add(clear($("stage")), h("div", { class: "w-placeholder" }, h("p", { class: "w-big", text: t("This event does not exist.") })));
        return;
      }
      failures++;
    }
    const base = (st?.poll || 6) * 1000 * Math.min(4, 1 + failures);
    timer = setTimeout(refresh, base + Math.random() * 2000);
  }
  setInterval(() => {
    if (preview || !st || document.hidden || video.paused) return;
    if (!(st.phase === "live" || st.phase === "vod")) return;
    fetch("/api/watch/" + slug + "/beat", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json", ...(accessToken ? { "x-access": accessToken } : {}) },
      body: JSON.stringify({ viewer: viewerId, session: st.session, lang: st.language }),
    }).catch(() => {});
  }, 30000);
  video.addEventListener("playing", () => {
    // First beacon right away, so the count reacts quickly.
    if (preview || !st || !(st.phase === "live" || st.phase === "vod")) return;
    fetch("/api/watch/" + slug + "/beat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(accessToken ? { "x-access": accessToken } : {}) },
      body: JSON.stringify({ viewer: viewerId, session: st.session, lang: st.language }),
    }).catch(() => {});
  });

  document.addEventListener("DOMContentLoaded", () => refresh(true));
})();
