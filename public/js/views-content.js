// Admin views: watch page editor, pre/after media and VOD, registration
// form builder, registrations.
"use strict";

const VARIABLES = () => [
  ["customer", t("Customer name")],
  ["event", t("Event title")],
  ["session", t("Session title")],
  ["date", t("Date")],
  ["start", t("Start time")],
  ["end", t("End time")],
  ["room", t("Room or location")],
  ["language", t("Selected language")],
  ["accountManager", t("Account manager")],
  ["accountManagerEmail", t("Account manager email")],
  ["watchUrl", t("Watch link")],
  ["registrationUrl", t("Registration link")],
  ["vodExpires", t("VOD expiry date")],
];

// ---- WYSIWYG editor with HTML source view -------------------------------------
function createEditor(initial = "", { onChange } = {}) {
  const area = h("div.editor-area.page-content", { contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": t("Page content") });
  const source = h("textarea.editor-source", { spellcheck: "false", "aria-label": t("HTML source"), hidden: true });
  let sourceMode = false;
  area.innerHTML = initial;
  const changed = () => onChange?.();
  area.addEventListener("input", changed);
  source.addEventListener("input", changed);
  const exec = (cmd, value = null) => {
    if (sourceMode) return;
    area.focus();
    document.execCommand(cmd, false, value);
    changed();
  };
  const insertHtml = (html) => exec("insertHTML", html);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Keep the selection while a dialog is open.
  let saved = null;
  const keep = () => {
    const s = window.getSelection();
    if (s.rangeCount && area.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    area.focus();
    if (saved) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(saved);
    }
  };
  area.addEventListener("keyup", keep);
  area.addEventListener("mouseup", keep);
  const btn = (label, title, fn) => h("button.tool", { type: "button", title, "aria-label": title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
  const linkDialog = (asButton) => {
    keep();
    const text = window.getSelection().toString();
    dialog(
      asButton ? t("Insert button") : t("Insert link"),
      [
        field(t("Text"), input("text", text || (asButton ? t("Watch now") : ""), { required: true })),
        field(t("Address"), input("href", "https://", { required: true }), t("https://, mailto: or tel:. Variables like {{watchUrl}} are allowed.")),
        checkbox("blank", t("Open in a new window"), asButton),
      ],
      [
        {
          label: t("Insert"),
          primary: true,
          run: (close, f) => {
            const d = formData(f);
            close();
            restore();
            insertHtml('<a href="' + esc(d.href) + '"' + (asButton ? ' class="button"' : "") + (d.blank ? ' target="_blank" rel="noopener noreferrer"' : "") + ">" + esc(d.text) + "</a>" + (asButton ? "&nbsp;" : ""));
          },
        },
      ],
    );
  };
  const imageDialog = async (img = null) => {
    keep();
    const urlInput = input("src", img?.getAttribute("src") || "", { required: true });
    const alignNow = img ? (img.style.float || (img.style.margin ? "center" : "")) : "";
    dialog(
      img ? t("Image properties") : t("Insert image"),
      [
        field(
          t("Image"),
          h("div.input-row", urlInput, h("button.secondary", { type: "button", onclick: async () => { const u = await pickMedia(); if (u) urlInput.value = u; } }, t("Choose"))),
        ),
        field(t("Alternative text"), input("alt", img?.getAttribute("alt") || "", { required: true }), t("Describes the image for people who cannot see it.")),
        h(
          "div.grid2",
          field(t("Width"), select("width", [["", t("Original")], ["100%", "100%"], ["75%", "75%"], ["50%", "50%"], ["33%", "33%"], ["25%", "25%"]], img?.style.width || "")),
          field(t("Alignment"), select("align", [["", t("Inline")], ["left", t("Left")], ["center", t("Centre")], ["right", t("Right")]], alignNow)),
        ),
      ],
      [
        img
          ? {
              label: t("Remove image"),
              danger: true,
              run: (close) => {
                img.remove();
                close();
                changed();
              },
            }
          : null,
        {
          label: img ? t("Apply") : t("Insert"),
          primary: true,
          run: (close, f) => {
            const d = formData(f);
            const style = [d.width ? "width:" + d.width : "max-width:100%", d.align === "left" ? "float:left;margin:0 16px 8px 0" : d.align === "right" ? "float:right;margin:0 0 8px 16px" : d.align === "center" ? "margin:0 auto" : ""]
              .filter(Boolean)
              .join(";");
            close();
            if (img) {
              img.setAttribute("src", d.src);
              img.setAttribute("alt", d.alt);
              img.setAttribute("style", style + (d.align === "center" ? ";display:block" : ""));
              changed();
            } else {
              restore();
              insertHtml('<img src="' + esc(d.src) + '" alt="' + esc(d.alt) + '" style="' + style + (d.align === "center" ? ";display:block" : "") + '">');
            }
          },
        },
      ].filter(Boolean),
    );
  };
  area.addEventListener("dblclick", (e) => {
    if (e.target.tagName === "IMG") imageDialog(e.target);
  });
  const varSel = select("var", [["", t("Insert variable…")], ...VARIABLES().map(([k, label]) => [k, label + "  {{" + k + "}}"])], "", { "aria-label": t("Insert variable") });
  varSel.addEventListener("mousedown", keep);
  varSel.addEventListener("change", () => {
    const k = varSel.value;
    varSel.value = "";
    if (!k) return;
    if (sourceMode) {
      const p = source.selectionStart;
      source.setRangeText("{{" + k + "}}", p, source.selectionEnd, "end");
      source.focus();
      changed();
    } else {
      restore();
      exec("insertText", "{{" + k + "}}");
    }
  });
  const blockSel = select("block", [["p", t("Paragraph")], ["h2", t("Heading")], ["h3", t("Subheading")], ["blockquote", t("Quote")]], "p", { "aria-label": t("Text style") });
  blockSel.addEventListener("change", () => exec("formatBlock", "<" + blockSel.value + ">"));
  const sourceBtn = h("button.tool.wide", { type: "button", "aria-pressed": "false", onclick: () => toggleSource() }, t("HTML"));
  const toolbar = h(
    "div.editor-toolbar",
    blockSel,
    btn(h("b", "B"), t("Bold"), () => exec("bold")),
    btn(h("i", "I"), t("Italic"), () => exec("italic")),
    btn(h("u", "U"), t("Underline"), () => exec("underline")),
    btn("•", t("Bulleted list"), () => exec("insertUnorderedList")),
    btn("1.", t("Numbered list"), () => exec("insertOrderedList")),
    btn("⟸", t("Align left"), () => exec("justifyLeft")),
    btn("⟺", t("Centre"), () => exec("justifyCenter")),
    btn("⟹", t("Align right"), () => exec("justifyRight")),
    btn("🔗", t("Insert link"), () => linkDialog(false)),
    btn("⛓̸", t("Remove link"), () => exec("unlink")),
    btn("▭", t("Insert button"), () => linkDialog(true)),
    btn("🖼", t("Insert image"), () => imageDialog()),
    btn("—", t("Horizontal line"), () => exec("insertHorizontalRule")),
    varSel,
    sourceBtn,
  );
  function toggleSource(force) {
    sourceMode = force ?? !sourceMode;
    if (sourceMode) source.value = area.innerHTML;
    else area.innerHTML = source.value;
    area.hidden = sourceMode;
    source.hidden = !sourceMode;
    sourceBtn.setAttribute("aria-pressed", String(sourceMode));
    toolbar.classList.toggle("source", sourceMode);
  }
  const el = h("div.editor", toolbar, area, source, h("p.muted.small", t("Double-click an image to change its alternative text, size or alignment. HTML is checked when saving; scripts and unapproved iframes are refused.")));
  return {
    el,
    html: () => (sourceMode ? source.value : area.innerHTML),
    set(html) {
      area.innerHTML = html;
      source.value = html;
    },
  };
}

// ---- Watch page -------------------------------------------------------------------------
EventTabs.page = async (body, ctx) => {
  const b = ctx.bundle;
  let pages = await GET("/api/admin/events/" + ctx.id + "/pages");
  let phase = "pre",
    langId = b.languages.find((l) => l.isDefault)?.id || b.languages[0].id,
    dirty = false,
    width = "desktop";
  const info = h("div.page-info");
  const editorBox = h("div");
  const frame = h("iframe.preview-frame", { title: t("Preview"), loading: "lazy" });
  const frameWrap = h("div.preview-wrap", frame);
  let editor;
  const current = () => pages.find((p) => p.phase === phase && p.languageId === langId);
  const previewUrl = () => b.event.watchUrl.replace(/^https?:\/\/[^/]+/, "") + qs({ preview: 1, phase, lang: b.languages.find((l) => l.id === langId).code, t: Date.now() });
  const show = () => {
    const p = current();
    fill(info, 
      p?.publishedAt ? h("span", t("Published {when} by {who}", { when: fmtDateTime(p.publishedAt), who: p.publishedBy })) : h("span", t("Not published yet")),
      p?.unpublished ? [" · ", pill(t("Unpublished changes"), "warn")] : null,
      p?.draftAt ? h("span.muted", " · " + t("Draft saved {when} by {who}", { when: fmtDateTime(p.draftAt), who: p.draftBy })) : null,
    );
    editor = createEditor(p?.draftHtml ?? "", { onChange: () => (dirty = true) });
    fill(editorBox, editor.el);
    dirty = false;
    frame.src = previewUrl();
  };
  const leave = async () => !dirty || (await confirmDialog(t("Unsaved changes"), t("Discard the changes you have not saved?"), t("Discard"), true));
  const save = async () => {
    const p = await PUT("/api/admin/events/" + ctx.id + "/pages/" + phase + "/" + langId, { html: editor.html() });
    pages = pages.filter((x) => !(x.phase === phase && x.languageId === langId)).concat(p);
    dirty = false;
    return p;
  };
  const phaseTabs = h(
    "div.segmented",
    Object.entries(PHASE_LABEL()).map(([k, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(k === phase),
          onclick: async (e) => {
            if (!(await leave())) return;
            phase = k;
            phaseTabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
            e.currentTarget.setAttribute("aria-pressed", "true");
            show();
          },
        },
        label,
      ),
    ),
  );
  const langSel = select("lang", b.languages.map((l) => [l.id, l.name + (l.active ? "" : " (" + t("inactive") + ")")]), langId, { "aria-label": t("Language") });
  langSel.addEventListener("change", async () => {
    if (!(await leave())) return (langSel.value = langId);
    langId = langSel.value;
    show();
  });
  const widthTabs = h(
    "div.segmented.small",
    [
      ["desktop", t("Desktop")],
      ["mobile", t("Mobile")],
    ].map(([k, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(k === width),
          onclick: (e) => {
            width = k;
            widthTabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false"));
            e.currentTarget.setAttribute("aria-pressed", "true");
            frameWrap.classList.toggle("mobile", k === "mobile");
          },
        },
        label,
      ),
    ),
  );
  const actions = h(
    "div.actions",
    h("button.secondary", { onclick: (e) => act(e.currentTarget, async () => { await save(); show(); toast(t("Draft saved. Viewers still see the published version.")); }) }, t("Save draft")),
    h(
      "button.primary",
      {
        onclick: async (e) => {
          const btnEl = e.currentTarget;
          if (!(await confirmDialog(t("Publish"), t("Publish this content for {phase} in {language}? Viewers see it within seconds.", { phase: PHASE_LABEL()[phase], language: langSel.selectedOptions[0].textContent }), t("Publish")))) return;
          act(btnEl, async () => {
            await save();
            const p = await POST("/api/admin/events/" + ctx.id + "/pages/" + phase + "/" + langId + "/publish");
            pages = pages.filter((x) => !(x.phase === phase && x.languageId === langId)).concat(p);
            show();
            toast(t("Published."));
          });
        },
      },
      t("Publish"),
    ),
    h(
      "button.link",
      {
        onclick: async () => {
          if (!(await confirmDialog(t("Back to published version"), t("Replace the draft with the published version?"), t("Replace"), true))) return;
          act(null, async () => {
            const p = await POST("/api/admin/events/" + ctx.id + "/pages/" + phase + "/" + langId + "/revert");
            pages = pages.filter((x) => !(x.phase === phase && x.languageId === langId)).concat(p);
            show();
          });
        },
      },
      t("Back to published version"),
    ),
    h("button.link", { onclick: () => applyTemplate() }, t("Apply template")),
    h("button.link", { onclick: () => saveTemplate() }, t("Save as template")),
  );
  const applyTemplate = async () => {
    const list = await GET("/api/admin/templates");
    if (!list.length) return toast(t("No templates yet."), "error");
    dialog(
      t("Apply template"),
      [field(t("Template"), select("id", list.map((x) => [x.id, x.name + (x.central ? " · " + t("central") : "")]), list[0].id)), h("p.muted.small", t("The template replaces the current content of the editor. Nothing is published until you publish."))],
      [
        {
          label: t("Apply"),
          primary: true,
          run: (close, f) => {
            const tpl = list.find((x) => x.id === formData(f).id);
            editor.set(tpl.html);
            dirty = true;
            close();
          },
        },
      ],
    );
  };
  const saveTemplate = () =>
    dialog(
      t("Save as template"),
      [field(t("Name"), input("name", "", { required: true })), can("templates.central") ? checkbox("central", t("Central template (available to all environments)"), false) : null],
      [
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              const d = formData(f);
              await POST("/api/admin/templates", { name: d.name, central: d.central, html: editor.html(), tenantId: b.event.tenantId });
              close();
              toast(t("Template saved."));
            }),
        },
      ],
    );
  App.onLeave = () => {
    if (dirty) toast(t("Unsaved changes on the watch page were not saved."), "error");
  };
  add(body, 
    h("div.toolbar", phaseTabs, langSel),
    info,
    editorBox,
    actions,
    h("div.title-row", h("h3", t("Preview (saved draft)")), h("div.toolbar", widthTabs, h("button.secondary", { onclick: (e) => act(e.currentTarget, async () => { await save(); frame.src = previewUrl(); }) }, t("Save and refresh preview")))),
    frameWrap,
  );
  show();
};

// ---- Media & VOD -------------------------------------------------------------------------
EventTabs.vod = async (body, ctx) => {
  let b = ctx.bundle;
  let sessionId = b.sessions.find((s) => s.phase === "after" || s.phase === "vod")?.id || b.sessions[0].id;
  let langId = b.languages.find((l) => l.isDefault)?.id || b.languages[0].id;
  const sessSel = select("session", b.sessions.map((s) => [s.id, s.title + " · " + fmtDateTime(s.startAt)]), sessionId, { "aria-label": t("Session") });
  const langSel = select("lang", b.languages.map((l) => [l.id, l.name]), langId, { "aria-label": t("Language") });
  const box = h("div");
  sessSel.addEventListener("change", () => ((sessionId = sessSel.value), render()));
  langSel.addEventListener("change", () => ((langId = langSel.value), render()));
  const variant = () => b.variants.find((v) => v.sessionId === sessionId && v.languageId === langId) || { preMedia: {}, afterMedia: {}, vod: {} };
  const base = () => "/api/admin/sessions/" + sessionId + "/languages/" + langId;

  const mediaForm = (key, title, help) => {
    const m = variant()[key] || {};
    const url = input("url", m.url || "", { placeholder: "https://…" });
    const poster = input("poster", m.poster || "", { placeholder: "https://…" });
    const kind = select("kind", [["none", t("Nothing (page content only)")], ["image", t("Image")], ["video", t("Video (HLS or MP4)")]], m.kind || "none");
    const posterField = field(t("Poster image (optional)"), h("div.input-row", poster, h("button.secondary", { type: "button", onclick: async () => { const u = await pickMedia(); if (u) poster.value = u; } }, t("Choose"))));
    const sync = () => (posterField.hidden = kind.value !== "video");
    kind.addEventListener("change", sync);
    sync();
    const f = h(
      "form.card",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const d = formData(f);
          act(f.querySelector("button[type=submit]"), async () => {
            b = await PUT(base() + "/media", { [key === "preMedia" ? "pre" : "after"]: { kind: d.kind, url: d.url, poster: d.poster, loop: d.loop } });
            ctx.set(b);
            toast(t("Saved."));
          });
        },
      },
      h("h3", title),
      h("p.muted.small", help),
      field(t("Show"), kind),
      field(t("Address"), h("div.input-row", url, h("button.secondary", { type: "button", onclick: async () => { const u = await pickMedia(); if (u) url.value = u; } }, t("Choose image")))),
      posterField,
      checkbox("loop", t("Repeat video"), m.loop),
      h("div.actions", h("button.primary", { type: "submit", disabled: !can("pages") }, t("Save"))),
    );
    return f;
  };

  const vodForm = () => {
    const v = variant().vod || {};
    const video = h("video.player", { controls: true, playsinline: true, preload: "metadata" });
    const url = input("url", v.url || "", { placeholder: "https://…/playlist.m3u8 " + t("or") + " .mp4" });
    const trimStart = input("trimStart", hms(v.trimStart), { placeholder: "0:00" });
    const trimEnd = input("trimEnd", hms(v.trimEnd), { placeholder: t("end") });
    const chapters = h("div.chapters");
    const addChapter = (c = { title: "", time: "" }) =>
      add(chapters, 
        h(
          "div.chapter-row",
          input("ctime", typeof c.time === "number" ? hms(c.time) : c.time, { placeholder: "0:00", "aria-label": t("Time"), class: "short" }),
          input("ctitle", c.title, { placeholder: t("Chapter title"), "aria-label": t("Chapter title") }),
          h("button.link", { type: "button", title: t("Jump"), onclick: (e) => (video.currentTime = parseTime(e.currentTarget.parentNode.querySelector("[name=ctime]").value) || 0) }, "▶"),
          h("button.link.danger", { type: "button", "aria-label": t("Remove chapter"), onclick: (e) => e.currentTarget.parentNode.remove() }, "×"),
        ),
      );
    (v.chapters || []).forEach(addChapter);
    const parseTime = (s) => {
      if (!String(s).trim()) return null;
      const parts = String(s).trim().split(":").map(Number);
      return parts.some((n) => !Number.isFinite(n)) ? NaN : parts.reduce((a, n) => a * 60 + n, 0);
    };
    const load = () => attachVideo(video, url.value.trim());
    url.addEventListener("change", load);
    const published = v.published;
    const unlimited = checkbox("unlimited", t("Available without end date"), v.unlimited);
    const reason = field(t("Reason for unlimited availability"), input("unlimitedReason", v.unlimitedReason || ""));
    const expire = field(t("Available until"), input("expireAt", toLocalInput(v.expireAt), { type: "datetime-local" }));
    const syncUnlimited = () => {
      const on = unlimited.querySelector("input").checked;
      reason.hidden = !on;
      expire.hidden = on;
    };
    unlimited.querySelector("input").addEventListener("change", syncUnlimited);
    syncUnlimited();
    let stopAt = null;
    video.addEventListener("timeupdate", () => {
      if (stopAt !== null && video.currentTime >= stopAt) {
        video.pause();
        stopAt = null;
      }
    });
    const f = h(
      "form.card",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const d = formData(f);
          const list = [...chapters.querySelectorAll(".chapter-row")].map((r) => ({ title: r.querySelector("[name=ctitle]").value, time: parseTime(r.querySelector("[name=ctime]").value) })).filter((c) => c.title && Number.isFinite(c.time));
          act(f.querySelector("button[type=submit]"), async () => {
            b = await PUT(base() + "/vod", {
              url: d.url.trim(),
              trimStart: parseTime(d.trimStart),
              trimEnd: parseTime(d.trimEnd),
              chapters: list,
              publishAt: fromLocalInput(d.publishAt),
              expireAt: d.unlimited ? null : fromLocalInput(d.expireAt),
              unlimited: d.unlimited,
              unlimitedReason: d.unlimitedReason,
            });
            ctx.set(b);
            toast(variant().vod.published || !published ? t("Saved.") : t("Saved. The recording changed, so it must be published again."));
            render();
          });
        },
      },
      h("div.title-row", h("h3", t("VOD")), published ? pill(variant().vodAvailable ? t("Published and available") : t("Published (not available now)"), variant().vodAvailable ? "ok" : "warn") : pill(t("Draft"), "muted")),
      h("p.muted.small", t("The recording appears on the same watch link once it is published and its publication date has been reached. Until then viewers see the after-live content.")),
      field(t("Recording address (HLS .m3u8 or MP4)"), url),
      h("div.player-wrap", video),
      h(
        "div.grid2",
        field(t("Start point"), h("div.input-row", trimStart, h("button.secondary", { type: "button", onclick: () => (trimStart.value = hms(video.currentTime)) }, t("Use player position")))),
        field(t("End point"), h("div.input-row", trimEnd, h("button.secondary", { type: "button", onclick: () => (trimEnd.value = hms(video.currentTime)) }, t("Use player position")))),
      ),
      h(
        "div.actions",
        h(
          "button.secondary",
          {
            type: "button",
            onclick: () => {
              const s = parseTime(trimStart.value) || 0;
              video.currentTime = s;
              stopAt = parseTime(trimEnd.value);
              video.play().catch(() => {});
            },
          },
          t("Play from start point"),
        ),
        h(
          "button.secondary",
          {
            type: "button",
            onclick: () => {
              const e = parseTime(trimEnd.value);
              if (!e) return;
              video.currentTime = Math.max(0, e - 10);
              stopAt = e;
              video.play().catch(() => {});
            },
          },
          t("Play last 10 seconds"),
        ),
      ),
      h("p.muted.small", t("Start and end point are applied by the player; the original recording stays unchanged. For bigger edits, add a newly edited recording.")),
      h("h4", t("Chapters")),
      chapters,
      h(
        "div.actions",
        h("button.secondary", { type: "button", onclick: () => addChapter() }, t("Add chapter")),
        h("button.secondary", { type: "button", onclick: () => addChapter({ title: "", time: hms(video.currentTime) }) }, t("Add chapter at player position")),
      ),
      h("h4", t("Availability")),
      h("div.grid2", field(t("Publication date (optional)"), input("publishAt", toLocalInput(v.publishAt), { type: "datetime-local" })), expire),
      unlimited,
      reason,
      h("div.actions", h("button.primary", { type: "submit", disabled: !can("vod") }, t("Save"))),
    );
    const pub = h(
      "div.card.publish-box",
      published
        ? [
            h("p", t("Published {when} by {who}.", { when: fmtDateTime(v.publishedAt), who: v.publishedBy || "—" })),
            h(
              "button.secondary",
              {
                disabled: !can("vod"),
                onclick: async (e) => {
                  const btnEl = e.currentTarget;
                  if (!(await confirmDialog(t("Withdraw VOD"), t("Viewers will see the after-live content again. Withdraw?"), t("Withdraw"), true))) return;
                  act(btnEl, async () => {
                    b = await POST(base() + "/vod/publish", { published: false });
                    ctx.set(b);
                    render();
                  });
                },
              },
              t("Withdraw"),
            ),
          ]
        : [
            h("p", t("Check the recording, start and end point and chapters, then approve it for viewers.")),
            h(
              "button.primary",
              {
                disabled: !can("vod") || !v.url,
                onclick: async (e) => {
                  const btnEl = e.currentTarget;
                  if (!(await confirmDialog(t("Publish VOD"), t("Make this recording available to viewers on the watch link?"), t("Publish")))) return;
                  act(btnEl, async () => {
                    b = await POST(base() + "/vod/publish", { published: true });
                    ctx.set(b);
                    render();
                    toast(t("VOD published."));
                  });
                },
              },
              t("Approve and publish"),
            ),
          ],
    );
    setTimeout(load, 0);
    App.onLeave = () => attachVideo(video, "");
    return [f, pub];
  };

  const render = () =>
    fill(box, 
      h("div.grid2.top", mediaForm("preMedia", t("Before the broadcast"), t("Shown in the pre phase above the page content, for example a teaser video or waiting screen.")), mediaForm("afterMedia", t("After live"), t("Shown after the broadcast until the VOD is published."))),
      can("vod") || can("pages") ? vodForm() : null,
    );
  add(body, h("div.toolbar", field(t("Session"), sessSel), field(t("Language"), langSel)), box);
  render();
};

// ---- Registration form builder ---------------------------------------------------------
const FIELD_TYPES = () => [
  ["text", t("Short text")],
  ["textarea", t("Long text")],
  ["email", t("Email address")],
  ["phone", t("Phone number")],
  ["number", t("Number")],
  ["date", t("Date")],
  ["checkbox", t("Single checkbox")],
  ["radio", t("Multiple choice (one answer)")],
  ["checkboxes", t("Multiple choice (several answers)")],
  ["select", t("Dropdown")],
  ["consent", t("Consent")],
];
const WATCH_T = (lang) => (s) => window.I18N?.watch?.[lang]?.[s] || s;

EventTabs.registration = async (body, ctx) => {
  const b = ctx.bundle;
  const form = await GET("/api/admin/events/" + ctx.id + "/form");
  const state = { enabled: form.enabled, approval: form.approval, fields: structuredClone(form.fields), texts: structuredClone(form.texts) };
  const def = b.languages.find((l) => l.isDefault) || b.languages[0];
  let textLang = def.code,
    previewLang = def.code,
    previewWidth = "desktop",
    dirty = false;
  const mark = () => {
    dirty = true;
    saveBtn.classList.add("attention");
  };
  const saveBtn = h(
    "button.primary",
    {
      onclick: (e) =>
        act(e.currentTarget, async () => {
          const out = await PUT("/api/admin/events/" + ctx.id + "/form", state);
          Object.assign(state, { enabled: out.enabled, approval: out.approval, fields: out.fields, texts: out.texts });
          dirty = false;
          saveBtn.classList.remove("attention");
          toast(t("Saved."));
          renderFields();
          renderPreview();
        }),
    },
    t("Save form"),
  );
  const settings = h(
    "section.card",
    h("h3", t("Registration")),
    h(
      "label.check",
      h("input", { type: "checkbox", checked: state.enabled, onchange: (e) => ((state.enabled = e.target.checked), mark()) }),
      h("span", t("Registration on")),
    ),
    b.event.access === "registration"
      ? [
          h("p.muted.small", t("Access to this event requires registration.")),
          h(
            "label.check",
            h("input", { type: "checkbox", checked: state.approval, onchange: (e) => ((state.approval = e.target.checked), mark()) }),
            h("span", t("Approve registrations manually before they give access")),
          ),
        ]
      : h("p.muted.small", t("The event is not set to “After registration”, so registration only collects sign-ups; the page stays open. Change this under General → Access.")),
    form.registrations ? h("p.muted.small", t("{n} registrations received. Earlier registrations stay readable when you change the fields.", { n: form.registrations })) : null,
  );
  const textsBox = h("section.card");
  const renderTexts = () => {
    const tx = (state.texts[textLang] ||= { intro: "", privacy: "", confirmation: "", pending: "", submit: "" });
    const area = (key, label, help) => {
      const el = textarea(key, tx[key], { rows: 3 });
      el.addEventListener("input", () => ((tx[key] = el.value), mark(), renderPreview()));
      return field(label, el, help);
    };
    const submit = input("submit", tx.submit, { placeholder: WATCH_T(textLang)("Register") });
    submit.addEventListener("input", () => ((tx.submit = submit.value), mark(), renderPreview()));
    const sel = select("textLang", b.languages.map((l) => [l.code, l.name]), textLang, { "aria-label": t("Language") });
    sel.addEventListener("change", () => ((textLang = sel.value), renderTexts()));
    fill(textsBox, 
      h("div.title-row", h("h3", t("Texts")), sel),
      area("intro", t("Introduction")),
      area("privacy", t("Privacy text")),
      area("confirmation", t("Confirmation (shown after registering)")),
      b.event.access === "registration" ? area("pending", t("Text while waiting for approval")) : null,
      field(t("Button text"), submit),
    );
  };
  const fieldsBox = h("section.card");
  const typeLabel = (k) => FIELD_TYPES().find(([x]) => x === k)?.[1] || k;
  const renderFields = () => {
    fill(fieldsBox, 
      h("div.title-row", h("h3", t("Fields")), h("div.toolbar", select("newType", FIELD_TYPES(), "text", { id: "newType", "aria-label": t("Field type") }), h("button.secondary", { onclick: () => editField(null, $("#newType").value) }, t("Add field")))),
      state.fields.length
        ? h(
            "ol.field-list",
            state.fields.map((f, i) =>
              h(
                "li" + (f.active ? "" : ".inactive"),
                h("div", h("strong", f.label.slice(0, 120)), h("div.muted.small", typeLabel(f.type) + (f.required ? " · " + t("required") : " · " + t("optional")) + (f.active ? "" : " · " + t("inactive")) + (f.options ? " · " + t("{n} options", { n: f.options.length }) : ""))),
                h(
                  "div.row-actions",
                  h("button.tool", { "aria-label": t("Move up"), disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
                  h("button.tool", { "aria-label": t("Move down"), disabled: i === state.fields.length - 1, onclick: () => move(i, 1) }, "↓"),
                  h("button.link", { onclick: () => editField(f) }, t("Edit")),
                  h(
                    "button.link.danger",
                    {
                      onclick: async () => {
                        if (!(await confirmDialog(t("Remove field"), t("Remove “{name}”? Answers already received stay in the registrations.", { name: f.label.slice(0, 60) }), t("Remove"), true))) return;
                        state.fields.splice(i, 1);
                        mark();
                        renderFields();
                        renderPreview();
                      },
                    },
                    t("Remove"),
                  ),
                ),
              ),
            ),
          )
        : h("p.empty", t("No fields yet. Choose a field type and click Add field.")),
    );
  };
  const move = (i, d) => {
    const [f] = state.fields.splice(i, 1);
    state.fields.splice(i + d, 0, f);
    mark();
    renderFields();
    renderPreview();
  };
  const editField = (f, type) => {
    const isNew = !f;
    const work = f ? structuredClone(f) : { id: "", type, label: "", help: "", placeholder: "", required: false, active: true, translations: {} };
    if (["radio", "checkboxes", "select"].includes(work.type)) work.options ||= [{ id: "", label: "" }];
    const optBox = h("div.options");
    const others = b.languages.filter((l) => l.code !== def.code);
    const renderOptions = () => {
      if (!work.options) return;
      fill(optBox, 
        h("h4", t("Answer options")),
        work.options.map((o, i) => {
          const inp = input("opt", o.label, { "aria-label": t("Option {n}", { n: i + 1 }), required: true });
          inp.addEventListener("input", () => (o.label = inp.value));
          return h(
            "div.option-row",
            inp,
            h("button.tool", { type: "button", "aria-label": t("Move up"), disabled: i === 0, onclick: () => (work.options.splice(i - 1, 0, ...work.options.splice(i, 1)), renderOptions()) }, "↑"),
            h("button.tool", { type: "button", "aria-label": t("Move down"), disabled: i === work.options.length - 1, onclick: () => (work.options.splice(i + 1, 0, ...work.options.splice(i, 1)), renderOptions()) }, "↓"),
            h("button.link.danger", { type: "button", disabled: work.options.length < 2, onclick: () => (work.options.splice(i, 1), renderOptions()) }, t("Remove")),
          );
        }),
        h("button.secondary", { type: "button", onclick: () => (work.options.push({ id: "", label: "" }), renderOptions()) }, t("Add option")),
      );
    };
    renderOptions();
    const trBox = h(
      "div",
      others.map((l) => {
        const tr = (work.translations[l.code] ||= { label: "", help: "", placeholder: "", options: {} });
        const mk = (key, label, area) => {
          const el = area ? textarea("tr_" + key, tr[key], { rows: 2 }) : input("tr_" + key, tr[key]);
          el.addEventListener("input", () => (tr[key] = el.value));
          return field(label, el);
        };
        return h(
          "details.translation",
          h("summary", t("Text in {language}", { language: l.name })),
          mk("label", work.type === "consent" ? t("Consent text") : t("Question or name"), work.type === "consent"),
          mk("help", t("Explanation")),
          work.type !== "consent" && work.type !== "checkbox" ? mk("placeholder", t("Placeholder")) : null,
          work.options
            ? h(
                "div",
                h("small.muted", t("Answer options (saved options only)")),
                work.options
                  .filter((o) => o.id)
                  .map((o) => {
                    const el = input("tropt", tr.options?.[o.id] || "", { placeholder: o.label });
                    el.addEventListener("input", () => ((tr.options ||= {})[o.id] = el.value));
                    return el;
                  }),
              )
            : null,
        );
      }),
    );
    const labelEl = work.type === "consent" ? textarea("label", work.label, { rows: 4, required: true }) : input("label", work.label, { required: true });
    dialog(
      (isNew ? t("New field") : t("Edit field")) + ": " + typeLabel(work.type),
      [
        field(work.type === "consent" ? t("Consent text") : t("Question or name"), labelEl, work.type === "consent" ? t("The exact text and the moment of consent are stored with each registration.") : null),
        field(t("Explanation (optional)"), input("help", work.help)),
        work.type !== "consent" && work.type !== "checkbox" ? field(t("Placeholder (optional)"), input("placeholder", work.placeholder)) : null,
        h("div.checks", checkbox("required", t("Required"), work.required), checkbox("active", t("Active"), work.active)),
        optBox,
        others.length ? h("h4", t("Other languages")) : null,
        trBox,
      ],
      [
        {
          label: t("Apply"),
          primary: true,
          run: (close, fm) => {
            const d = formData(fm);
            Object.assign(work, { label: d.label, help: d.help, placeholder: d.placeholder || "", required: d.required, active: d.active });
            if (work.options) work.options = work.options.filter((o) => o.label.trim());
            if (work.options && !work.options.length) return toast(t("Add at least one answer option."), "error");
            if (isNew) state.fields.push(work);
            else state.fields[state.fields.indexOf(f)] = work;
            close();
            mark();
            renderFields();
            renderPreview();
          },
        },
      ],
      { wide: true },
    );
  };
  const previewBox = h("div.form-preview");
  const previewSel = select("previewLang", b.languages.map((l) => [l.code, l.name]), previewLang, { "aria-label": t("Language") });
  previewSel.addEventListener("change", () => ((previewLang = previewSel.value), renderPreview()));
  const widthTabs = h(
    "div.segmented.small",
    [
      ["desktop", t("Desktop")],
      ["mobile", t("Mobile")],
    ].map(([k, label]) =>
      h("button", { type: "button", "aria-pressed": String(k === previewWidth), onclick: (e) => { previewWidth = k; widthTabs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false")); e.currentTarget.setAttribute("aria-pressed", "true"); renderPreview(); } }, label),
    ),
  );
  const renderPreview = () => {
    const tx = state.texts[previewLang] || state.texts[def.code] || {};
    const local = state.fields
      .filter((f) => f.active)
      .map((f) => {
        const tr = f.translations?.[previewLang] || {};
        return { ...f, label: tr.label || f.label, help: tr.help || f.help, placeholder: tr.placeholder || f.placeholder, options: f.options?.map((o) => ({ id: o.id, label: tr.options?.[o.id] || o.label })) };
      });
    const wt = WATCH_T(previewLang);
    const rf = RegForm.render({ intro: tx.intro, privacy: tx.privacy, fields: local }, { t: wt, idPrefix: "pv" });
    fill(previewBox, 
      h("div.watch-scope" + (previewWidth === "mobile" ? ".mobile" : ""), h("div.reg-card", h("h2", wt("Registration")), rf.el, h("button.w-primary", { type: "button", onclick: () => rf.showErrors(Object.fromEntries(local.filter((f) => f.required).map((f) => [f.id, f.type === "consent" ? "Please give your consent." : "This field is required."]))) }, tx.submit || wt("Register")))),
    );
  };
  App.onLeave = () => {
    if (dirty) toast(t("Unsaved changes in the registration form were not saved."), "error");
  };
  add(body, 
    h("div.title-row", h("h2", t("Registration form")), saveBtn),
    h("div.grid2.top", h("div", settings, textsBox, fieldsBox), h("div", h("section.card", h("div.title-row", h("h3", t("Preview")), h("div.toolbar", previewSel, widthTabs)), previewBox))),
  );
  renderTexts();
  renderFields();
  renderPreview();
};

// ---- Registrations ----------------------------------------------------------------------
EventTabs.registrations = async (body, ctx) => {
  const statusLabel = { received: t("Received"), pending: t("Pending"), approved: t("Approved"), rejected: t("Rejected") };
  const statusKind = { received: "ok", pending: "warn", approved: "ok", rejected: "muted" };
  const filters = h(
    "form.filters",
    { onsubmit: (e) => (e.preventDefault(), load()) },
    field(t("Search"), input("q", "", { type: "search", placeholder: t("Name, email, answer…") })),
    field(t("Status"), select("status", [["", t("All")], ...Object.entries(statusLabel)], "")),
    h("button.primary", { type: "submit" }, t("Search")),
  );
  const name = input("name", "", { placeholder: t("File name (optional)") });
  const exp = (format) => {
    const d = formData(filters);
    download("/api/admin/events/" + ctx.id + "/registrations/export" + qs({ format, q: d.q, status: d.status, lang: App.lang, name: name.value.trim() }));
  };
  const out = h("div");
  const setStatus = (g, status) =>
    act(null, async () => {
      await PATCH("/api/admin/registrations/" + g.id, { status });
      toast(t("Status changed."));
      load();
    });
  const open = (g, fields) =>
    dialog(
      t("Registration"),
      [
        h("p", statusPill2(g.status), " ", fmtDateTime(g.createdAt), " · ", g.language),
        h("dl.answers", fields.map((f) => [h("dt", f.label, f.removed ? h("small.muted", " (" + t("removed field") + ")") : null), h("dd", answerText(g.answers[f.id]) || "—")])),
        g.consent.length ? [h("h4", t("Consent")), h("ul", g.consent.map((c) => h("li", fmtDateTime(c.at) + " — " + c.text)))] : null,
        h("div.actions", Object.keys(statusLabel).filter((s) => s !== g.status).map((s) => h("button.secondary", { type: "button", onclick: () => setStatus(g, s) }, t("Mark as {status}", { status: statusLabel[s].toLowerCase() })))),
      ],
      [
        {
          label: t("Delete"),
          danger: true,
          run: async (close) => {
            if (!(await confirmDialog(t("Delete registration"), t("Delete this registration permanently?"), t("Delete"), true))) return;
            act(null, async () => {
              await DELETE("/api/admin/registrations/" + g.id);
              close();
              load();
            });
          },
        },
      ],
      { wide: true, cancel: t("Close") },
    );
  const answerText = (v) => (v === "Yes" ? t("Yes") : v === "No" ? t("No") : v);
  const statusPill2 = (s) => pill(statusLabel[s], statusKind[s]);
  const load = () =>
    act(filters.querySelector("button"), async () => {
      const d = formData(filters);
      const data = await GET("/api/admin/events/" + ctx.id + "/registrations" + qs(d));
      const shown = data.fields.filter((f) => !["consent", "textarea"].includes(f.type)).slice(0, 4);
      fill(out, 
        h("p.muted", t("{n} of {total} registrations", { n: data.rows.length, total: data.total })),
        table(
          [
            { label: t("Received"), value: (g) => fmtDateTime(g.createdAt) },
            { label: t("Status"), value: (g) => statusPill2(g.status) },
            { label: t("Email"), value: (g) => g.email || "—" },
            ...shown.filter((f) => f.type !== "email").map((f) => ({ label: f.label.slice(0, 40), value: (g) => answerText(g.answers[f.id]) || "—" })),
            { label: t("Language"), value: (g) => g.language },
            {
              label: "",
              value: (g) =>
                g.status === "pending"
                  ? h(
                      "div.row-actions",
                      h("button.secondary", { onclick: (e) => (e.stopPropagation(), setStatus(g, "approved")) }, t("Approve")),
                      h("button.link.danger", { onclick: (e) => (e.stopPropagation(), setStatus(g, "rejected")) }, t("Reject")),
                    )
                  : "",
            },
          ],
          data.rows,
          { onRow: (g) => open(g, data.fields), empty: t("No registrations found.") },
        ),
      );
    });
  add(body, 
    h("div.title-row", h("h2", t("Registrations")), h("div.toolbar", name, h("button.secondary", { onclick: () => exp("csv") }, t("Download CSV")), h("button.secondary", { onclick: () => exp("xlsx") }, t("Download Excel")))),
    filters,
    out,
  );
  load();
};
