// Player controls for the watch page: play/pause, seek bar (recordings),
// LIVE badge with "go live", volume, language, subtitles, speed, quality
// and full screen. Attached once to the persistent player frame; the page
// calls update() whenever the state changes and sourceChanged() when a new
// video is loaded. Subtitle text is shown by this script (WebVTT parsed
// here), so it works the same for every video address.
"use strict";
(function () {
  const SVG = (d) => '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + d + '"/></svg>';
  const ICON = {
    play: SVG("M8 5v14l11-7z"),
    pause: SVG("M6 5h4v14H6zm8 0h4v14h-4z"),
    volume: SVG("M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"),
    muted: SVG("M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5zM19 12a7 7 0 0 1-.6 2.8l1.5 1.5A9 9 0 0 0 21 12a9 9 0 0 0-7-8.8v2.1A7 7 0 0 1 19 12zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.2 4.2c-.7.5-1.4.9-2.2 1.1v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3L4.3 3zM12 4 9.9 6.1 12 8.2z"),
    language: SVG("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6A15.7 15.7 0 0 0 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.2 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.8-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z"),
    captions: SVG("M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z"),
    settings: SVG("M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.7 1.7 1l.4 2.6c0 .2.3.4.5.4h4c.2 0 .5-.2.5-.4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"),
    full: SVG("M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"),
    exit: SVG("M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z"),
  };
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };
  const clock = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const s = sec % 60,
      m = Math.floor(sec / 60) % 60,
      hh = Math.floor(sec / 3600);
    return (hh ? hh + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };

  // ---- WebVTT --------------------------------------------------------------
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&quot;": '"', "&#39;": "'" };
  function parseVtt(text) {
    const cues = [];
    const sec = (hh, mm, ss, ms) => (Number(hh) || 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(String(ms).padEnd(3, "0")) / 1000;
    for (const block of String(text).replace(/\r/g, "").split(/\n{2,}/)) {
      const lines = block.split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) continue;
      const m = lines[i].match(/^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
      if (!m) continue;
      const body = lines
        .slice(i + 1)
        .join("\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&(?:amp|lt|gt|nbsp|quot|#39);/g, (x) => entities[x])
        .trim();
      if (body) cues.push({ start: sec(m[1], m[2], m[3], m[4]), end: sec(m[5], m[6], m[7], m[8]), text: body });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  // api: { t, kind(), trim(), hls(), languages(), language(), setLanguage(code),
  //        subtitles(), headers(), rememberedCaption(), rememberCaption(v) }
  function attach(frame, video, api) {
    const t = api.t;
    const stop = new AbortController();
    const on = (el, ev, fn, o) => el.addEventListener(ev, fn, { signal: stop.signal, ...o });
    video.controls = false;
    frame.tabIndex = 0;
    frame.setAttribute("role", "group");

    // ---- Elements ---------------------------------------------------------------
    const playBtn = h("button", { type: "button", class: "w-btn" });
    const muteBtn = h("button", { type: "button", class: "w-btn" });
    const volume = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: "1", class: "w-volume" });
    const timeEl = h("span", { class: "w-time" });
    const liveBadge = h("span", { class: "w-livebadge" }, h("i"), t("Live"));
    const goLive = h("button", { type: "button", class: "w-golive" }, t("Go to live"));
    const seek = h("input", { type: "range", min: "0", max: "0", step: "0.1", value: "0", class: "w-seek" });
    const langBtn = h("button", { type: "button", class: "w-btn w-txt", "aria-haspopup": "menu" });
    const ccBtn = h("button", { type: "button", class: "w-btn", "aria-haspopup": "menu", html: ICON.captions });
    const setBtn = h("button", { type: "button", class: "w-btn", "aria-haspopup": "menu", html: ICON.settings });
    const fsBtn = h("button", { type: "button", class: "w-btn" });
    const menu = h("div", { class: "w-menu", role: "menu", hidden: true });
    const caption = h("div", { class: "w-caption", "aria-live": "off", hidden: true });
    const bar = h("div", { class: "w-bar" }, playBtn, muteBtn, volume, timeEl, liveBadge, goLive, h("span", { class: "w-spacer" }), langBtn, ccBtn, setBtn, fsBtn);
    const ctl = h("div", { class: "w-ctl" }, seek, bar);
    const big = h("button", { type: "button", class: "w-big-play", html: ICON.play, "aria-label": t("Play") });
    frame.append(caption, big, ctl, menu);

    // ---- Subtitles --------------------------------------------------------------
    // tracks: [{ key, label, lang, source: "vod"|"hls", url?, index? }]
    let tracks = [];
    let selected = ""; // key of the track that is shown; "" = off
    const loaded = new Map(); // key → cues
    let cues = [];
    let hint = 0;
    let hlsText = null;
    function collectTracks() {
      const list = (api.subtitles() || []).map((x) => ({ key: "vod:" + x.id, label: x.label, lang: x.lang, source: "vod", url: x.url }));
      const hls = api.hls();
      (hls?.subtitleTracks || []).forEach((x, i) => list.push({ key: "hls:" + i, label: x.name || x.lang || "Subtitles", lang: x.lang || "", source: "hls", index: i }));
      return list;
    }
    async function choose(key, remember = true) {
      selected = key;
      cues = [];
      hint = 0;
      if (hlsText) {
        hlsText.removeEventListener("cuechange", showHlsCues);
        hlsText = null;
      }
      const hls = api.hls();
      if (hls) {
        hls.subtitleDisplay = false;
        if (!key.startsWith("hls:")) hls.subtitleTrack = -1;
      }
      const tr = tracks.find((x) => x.key === key);
      if (remember) api.rememberCaption(tr ? tr.lang || tr.label : "off");
      if (!tr) return paintCaption("");
      if (tr.source === "vod") {
        if (!loaded.has(key)) {
          try {
            const res = await fetch(tr.url, { headers: api.headers(), credentials: "same-origin" });
            loaded.set(key, res.ok ? parseVtt(await res.text()) : []);
          } catch {
            loaded.set(key, []);
          }
        }
        if (selected === key) cues = loaded.get(key);
      } else if (hls) {
        hls.subtitleTrack = tr.index;
        // hls.js fills a text track of its own; its cues are shown here.
        setTimeout(() => {
          if (selected !== key) return;
          hlsText = [...video.textTracks].find((x) => (x.kind === "subtitles" || x.kind === "captions") && x.label === tr.label) || null;
          if (hlsText) {
            hlsText.mode = "hidden";
            hlsText.addEventListener("cuechange", showHlsCues);
          }
        }, 300);
      }
      tick();
    }
    function showHlsCues() {
      paintCaption([...(hlsText?.activeCues || [])].map((c) => c.text.replace(/<[^>]*>/g, "")).join("\n"));
    }
    function paintCaption(text) {
      caption.hidden = !text;
      if (caption.textContent !== text) caption.textContent = text;
    }
    function tick() {
      if (!selected || !cues.length) return selected.startsWith("hls:") ? undefined : paintCaption("");
      const now = video.currentTime;
      if (hint >= cues.length || cues[hint].start > now) hint = 0;
      let text = "";
      for (let i = hint; i < cues.length && cues[i].start <= now; i++) {
        if (cues[i].end > now) text = text ? text + "\n" + cues[i].text : cues[i].text;
        if (cues[i].end < now && i === hint) hint = i + 1;
      }
      paintCaption(text);
    }
    const tickTimer = setInterval(tick, 150);
    // The live edge moves on while paused: keep the "go live" button current.
    const paintTimer = setInterval(() => api.kind() === "live" && paint(), 1000);
    stop.signal.addEventListener("abort", () => (clearInterval(tickTimer), clearInterval(paintTimer)));

    // ---- Menus --------------------------------------------------------------------
    let openFor = null;
    function closeMenu() {
      menu.hidden = true;
      openFor = null;
      for (const b of [langBtn, ccBtn, setBtn]) b.setAttribute("aria-expanded", "false");
    }
    function openMenu(btn, groups) {
      if (openFor === btn) return closeMenu();
      closeMenu();
      openFor = btn;
      btn.setAttribute("aria-expanded", "true");
      menu.replaceChildren(
        ...groups.flatMap((g) => [
          g.title ? h("div", { class: "w-menu-title" }, g.title) : null,
          ...g.items.map((it) =>
            h(
              "button",
              {
                type: "button",
                role: "menuitemradio",
                "aria-checked": String(Boolean(it.checked)),
                lang: it.lang,
                onclick: () => {
                  closeMenu();
                  it.pick();
                },
              },
              h("span", { class: "w-check", "aria-hidden": "true" }, it.checked ? "✓" : ""),
              it.label,
            ),
          ),
        ]),
      );
      menu.hidden = false;
      // Right edge of the menu under the button, above the control bar.
      const fr = frame.getBoundingClientRect(),
        br = btn.getBoundingClientRect();
      menu.style.right = Math.max(8, fr.right - br.right) + "px";
      menu.querySelector("[aria-checked=true]")?.focus();
    }
    on(langBtn, "click", () =>
      openMenu(langBtn, [{ title: t("Language"), items: api.languages().map((l) => ({ label: l.name, lang: l.code, checked: l.code === api.language(), pick: () => api.setLanguage(l.code) })) }]),
    );
    on(ccBtn, "click", () =>
      openMenu(ccBtn, [
        {
          title: t("Subtitles"),
          items: [{ label: t("Off"), checked: !selected, pick: () => choose("") }, ...tracks.map((x) => ({ label: x.label, lang: x.lang, checked: x.key === selected, pick: () => choose(x.key) }))],
        },
      ]),
    );
    on(setBtn, "click", () => {
      const groups = [];
      if (api.kind() !== "live") {
        groups.push({ title: t("Speed"), items: [0.75, 1, 1.25, 1.5, 2].map((r) => ({ label: r === 1 ? t("Normal") : r + "×", checked: video.playbackRate === r, pick: () => (video.playbackRate = r) })) });
      }
      const hls = api.hls();
      if (hls && hls.levels?.length > 1) {
        groups.push({
          title: t("Quality"),
          items: [{ label: t("Auto"), checked: hls.autoLevelEnabled, pick: () => (hls.currentLevel = -1) }, ...hls.levels.map((lv, i) => ({ label: (lv.height ? lv.height + "p" : Math.round(lv.bitrate / 1000) + " kbps"), checked: !hls.autoLevelEnabled && hls.currentLevel === i, pick: () => (hls.currentLevel = i) })).reverse()],
        });
      }
      if (groups.length) openMenu(setBtn, groups);
    });
    on(document, "pointerdown", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && ![langBtn, ccBtn, setBtn].some((b) => b.contains(e.target))) closeMenu();
    });
    on(menu, "keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") (items[i + 1] || items[0]).focus();
      else if (e.key === "ArrowUp") (items[i - 1] || items[items.length - 1]).focus();
      else return;
      e.preventDefault();
    });

    // ---- Playback controls -----------------------------------------------------
    const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
    const range = () => {
      const tr = api.trim();
      const start = tr.start || 0;
      const end = tr.end || (Number.isFinite(video.duration) ? video.duration : 0);
      return { start, end };
    };
    const liveEdge = () => {
      const hls = api.hls();
      if (hls && Number.isFinite(hls.liveSyncPosition)) return { edge: hls.liveSyncPosition, slack: 4 };
      const s = video.seekable;
      return s && s.length ? { edge: s.end(s.length - 1), slack: 12 } : { edge: NaN, slack: 12 };
    };
    on(playBtn, "click", toggle);
    on(big, "click", toggle);
    on(goLive, "click", () => {
      const { edge } = liveEdge();
      if (Number.isFinite(edge)) video.currentTime = edge;
      video.play().catch(() => {});
    });
    on(muteBtn, "click", () => (video.muted = !video.muted));
    on(volume, "input", () => {
      video.volume = Number(volume.value);
      video.muted = video.volume === 0;
    });
    on(seek, "input", () => {
      const { start } = range();
      video.currentTime = start + Number(seek.value);
    });
    const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
    on(fsBtn, "click", () => {
      if (fsElement()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      const req = frame.requestFullscreen || frame.webkitRequestFullscreen;
      if (req) req.call(frame);
      else video.webkitEnterFullscreen?.();
    });
    on(document, "fullscreenchange", paint);
    on(document, "webkitfullscreenchange", paint);
    for (const ev of ["play", "pause", "volumechange", "timeupdate", "durationchange", "loadedmetadata", "ratechange", "progress", "emptied"]) on(video, ev, paint);

    function paint() {
      const live = api.kind() === "live";
      const paused = video.paused;
      playBtn.innerHTML = paused ? ICON.play : ICON.pause;
      playBtn.setAttribute("aria-label", paused ? t("Play") : t("Pause"));
      const silent = video.muted || video.volume === 0;
      muteBtn.innerHTML = silent ? ICON.muted : ICON.volume;
      muteBtn.setAttribute("aria-label", silent ? t("Unmute") : t("Mute"));
      volume.setAttribute("aria-label", t("Volume"));
      volume.value = silent ? "0" : String(video.volume);
      const fs = fsElement() === frame;
      fsBtn.innerHTML = fs ? ICON.exit : ICON.full;
      fsBtn.setAttribute("aria-label", fs ? t("Exit full screen") : t("Full screen"));
      frame.classList.toggle("is-paused", paused);
      frame.classList.toggle("is-live", live);
      big.hidden = !paused;
      if (live) {
        const { edge, slack } = liveEdge();
        const behind = Number.isFinite(edge) && edge - video.currentTime > slack;
        liveBadge.hidden = false;
        liveBadge.classList.toggle("is-behind", behind);
        goLive.hidden = !behind;
        timeEl.hidden = true;
        seek.hidden = true;
      } else {
        const { start, end } = range();
        liveBadge.hidden = true;
        goLive.hidden = true;
        timeEl.hidden = false;
        seek.hidden = !(end > start);
        seek.max = String(Math.max(0, end - start));
        seek.value = String(Math.min(Math.max(0, video.currentTime - start), end - start));
        seek.style.setProperty("--fill", end > start ? ((Number(seek.value) / (end - start)) * 100).toFixed(2) + "%" : "0%");
        seek.setAttribute("aria-label", t("Seek"));
        seek.setAttribute("aria-valuetext", clock(Number(seek.value)) + " / " + clock(end - start));
        timeEl.textContent = clock(Math.max(0, video.currentTime - start)) + " / " + clock(end - start);
      }
    }

    // ---- Showing and hiding -------------------------------------------------------
    let idleTimer = null;
    const wake = () => {
      frame.classList.remove("idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const keyboard = ctl.matches(":focus-within") && document.activeElement?.matches(":focus-visible");
        if (!video.paused && menu.hidden && !keyboard) frame.classList.add("idle");
      }, 3000);
    };
    for (const ev of ["pointermove", "pointerdown", "keydown", "focusin"]) on(frame, ev, wake);
    on(video, "pause", wake);
    on(video, "click", (e) => e.preventDefault());
    let touched = false;
    on(video, "pointerdown", (e) => (touched = e.pointerType === "touch" && frame.classList.contains("idle")));
    on(video, "pointerup", () => {
      if (touched) return wake(); // first tap on a touch screen only shows the controls
      closeMenu();
      toggle();
    });
    on(video, "dblclick", () => fsBtn.click());
    on(frame, "keydown", (e) => {
      if (e.target.closest?.("input,select,textarea") && e.target !== seek && e.target !== volume) return;
      if (e.target.closest?.("button") && (e.key === " " || e.key === "Enter")) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const live = api.kind() === "live";
      const k = e.key.toLowerCase();
      if (k === " " || k === "k") toggle();
      else if (k === "m") muteBtn.click();
      else if (k === "f") fsBtn.click();
      else if (k === "c" && !ccBtn.hidden) {
        const next = selected ? "" : tracks[0]?.key || "";
        choose(next);
      } else if (!live && (k === "arrowleft" || k === "j")) video.currentTime -= k === "j" ? 10 : 5;
      else if (!live && (k === "arrowright" || k === "l")) video.currentTime += k === "l" ? 10 : 5;
      else if (k === "escape" && !menu.hidden) closeMenu();
      else return;
      e.preventDefault();
    });

    // ---- Called by the page --------------------------------------------------------
    function update() {
      tracks = collectTracks();
      const langs = api.languages();
      langBtn.hidden = langs.length < 2;
      langBtn.textContent = (api.language() || "").slice(0, 2).toUpperCase();
      langBtn.setAttribute("aria-label", t("Language"));
      ccBtn.hidden = !tracks.length;
      ccBtn.setAttribute("aria-label", t("Subtitles"));
      ccBtn.classList.toggle("is-on", Boolean(selected));
      const hls = api.hls();
      const hasQuality = hls && hls.levels?.length > 1;
      setBtn.hidden = api.kind() === "live" && !hasQuality;
      setBtn.setAttribute("aria-label", t("Settings"));
      if (selected && !tracks.some((x) => x.key === selected)) choose("", false);
      // A remembered choice comes back as soon as a track in that language exists.
      if (!selected && tracks.length && !autoDone) {
        const want = api.rememberedCaption();
        const match = want && want !== "off" ? tracks.find((x) => x.lang === want || x.label === want) : null;
        autoDone = true;
        if (match) choose(match.key, false);
      }
      paint();
    }
    let autoDone = false;
    function sourceChanged() {
      closeMenu();
      selected = "";
      cues = [];
      autoDone = false;
      paintCaption("");
      video.playbackRate = 1;
      update();
    }
    paint();
    update();
    wake();
    return {
      update,
      sourceChanged,
      destroy() {
        stop.abort();
        clearTimeout(idleTimer);
        for (const el of [caption, big, ctl, menu]) el.remove();
      },
    };
  }

  window.Player = { attach, parseVtt };
})();
