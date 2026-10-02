// Admin views: event list and event screens (general, sessions, languages,
// streams, live control, Green Room).
"use strict";

App.views.events = async (main, [id, tab]) => {
  if (id) return eventView(main, id, tab || "overview");
  let filter = "active";
  const box = h("div");
  const load = async () => {
    const list = await GET("/api/admin/events" + qs({ status: filter }));
    fill(box, 
      table(
        [
          { label: t("Reference"), value: (e) => e.reference },
          { label: t("Event"), value: (e) => h("a", { href: "#/events/" + e.id }, e.title) },
          { label: t("Customer"), value: (e) => e.customerName || "—" },
          App.me.platform ? { label: t("Environment"), value: (e) => e.tenantName } : null,
          { label: t("Start"), value: (e) => fmtDateTime(e.firstStart) },
          { label: t("Sessions"), value: (e) => String(e.sessions), class: "num" },
          { label: t("Languages"), value: (e) => String(e.languages), class: "num" },
          { label: t("Status"), value: (e) => statusPill(e.status) },
        ].filter(Boolean),
        list,
        { onRow: (e) => (location.hash = "#/events/" + e.id), empty: t("No events found.") },
      ),
    );
  };
  const tabs = h(
    "div.segmented",
    [
      ["active", t("Current")],
      ["test", t("Test")],
      ["scheduled", t("Scheduled")],
      ["draft", t("Draft")],
      ["archived", t("Archived")],
    ].map(([v, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(v === filter),
          onclick: (e) => {
            filter = v;
            tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
            e.currentTarget.setAttribute("aria-pressed", "true");
            load();
          },
        },
        label,
      ),
    ),
  );
  add(main, h("div.title-row", h("h1", t("Events")), can("events.edit") ? h("button.primary", { onclick: newEventDialog }, t("New event")) : null), tabs, box);
  await load();
};

async function newEventDialog() {
  const customers = (await GET("/api/admin/customers")).filter((c) => c.status === "active");
  const start = new Date(Date.now() + 7 * 864e5);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600e3);
  dialog(
    t("New event"),
    [
      field(t("Title"), input("title", "", { required: true })),
      field(t("Customer"), select("customerId", [["", t("No customer")], ...customers.map((c) => [c.id, c.name + (App.me.platform ? " · " + c.tenantName : "")])], ""), t("The customer's branding is applied to the new event.")),
      App.me.platform ? tenantSelect() : null,
      h("div.grid2", field(t("Start"), input("startAt", toLocalInput(start.toISOString()), { type: "datetime-local", required: true })), field(t("End"), input("endAt", toLocalInput(end.toISOString()), { type: "datetime-local", required: true }))),
      h("div.grid2", field(t("Default language code"), input("languageCode", "nl", { required: true, pattern: "[a-z]{2,3}(-[a-z0-9]{2,8})?" })), field(t("Language name"), input("languageName", "Nederlands", { required: true }))),
    ],
    [
      {
        label: t("Create"),
        primary: true,
        run: (close, f) =>
          act(null, async () => {
            const d = formData(f);
            const b = await POST("/api/admin/events", { ...d, startAt: fromLocalInput(d.startAt), endAt: fromLocalInput(d.endAt) });
            close();
            location.hash = "#/events/" + b.event.id;
          }),
      },
    ],
  );
}

const EVENT_TABS = () => [
  ["overview", t("General"), "events.view"],
  ["sessions", t("Sessions"), "events.view"],
  ["languages", t("Languages"), "events.view"],
  ["streams", t("Streams"), "streams"],
  ["greenroom", t("Green Room"), "streams"],
  ["live", t("Live control"), "live"],
  ["page", t("Watch page"), "pages"],
  ["vod", t("Media & VOD"), "pages|vod"],
  ["registration", t("Registration form"), "forms"],
  ["registrations", t("Registrations"), "registrations"],
  ["usage", t("Usage"), "usage"],
];

async function eventView(main, id, tab) {
  const ctx = { id, bundle: await GET("/api/admin/events/" + id) };
  ctx.reload = async () => {
    ctx.bundle = await GET("/api/admin/events/" + id);
    renderHeader();
    return ctx.bundle;
  };
  ctx.set = (b) => {
    ctx.bundle = b;
    renderHeader();
  };
  const header = h("div.event-head");
  const renderHeader = () => {
    const e = ctx.bundle.event;
    fill(header, 
      h("p.crumbs", h("a", { href: "#/events" }, t("Events"))),
      h("div.title-row", h("h1", e.title, " ", statusPill(e.status)), h("div.muted", e.reference + (e.customerName ? " · " + e.customerName : ""))),
      h("div.link-row", h("a", { href: e.watchUrl, target: "_blank", rel: "noopener" }, e.watchUrl), h("button.link", { onclick: () => copyText(e.watchUrl) }, t("Copy link"))),
    );
  };
  renderHeader();
  const tabs = EVENT_TABS().filter(([, , p]) => p.split("|").some(can));
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  const nav = h(
    "nav.tabs",
    { "aria-label": t("Event sections") },
    tabs.map(([k, label]) => h("a", { href: "#/events/" + id + "/" + k, class: k === tab ? "active" : "", "aria-current": k === tab ? "page" : undefined }, label)),
  );
  const body = h("div.tab-body");
  add(main, header, nav, body);
  await EventTabs[tab](body, ctx);
}

const EventTabs = (window.EventTabs = {});

// ---- General ----------------------------------------------------------------------
EventTabs.overview = async (body, ctx) => {
  const e = ctx.bundle.event;
  const editable = can("events.edit");
  const customers = editable ? (await GET("/api/admin/customers")).filter((c) => c.tenantId === e.tenantId) : [];
  const statusButtons = h(
    "div.segmented",
    Object.entries(STATUS_LABEL()).map(([s, label]) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(s === e.status),
          disabled: !(can("events.edit") || (can("live") && s !== "archived")),
          onclick: async (ev) => {
            if (s === e.status) return;
            const text = {
              draft: t("The watch page shows the pre phase. Nothing goes live."),
              test: t("Streams can be checked in the Green Room. The watch page keeps showing the pre phase."),
              scheduled: t("The watch page follows the schedule: live at the start time, after live at the end time."),
              archived: t("The event is no longer live. The watch page shows the after phase or the VOD."),
            }[s];
            if (!(await confirmDialog(t("Change status to {s}?", { s: label }), text, t("Change status")))) return;
            act(ev.currentTarget, async () => {
              ctx.set(await POST("/api/admin/events/" + e.id + "/status", { status: s }));
              App.route();
            });
          },
        },
        label,
      ),
    ),
  );
  const form = h(
    "form.card",
    {
      onsubmit: (ev) => {
        ev.preventDefault();
        const d = formData(form);
        act(form.querySelector("button[type=submit]"), async () => {
          const payload = {
            title: d.title,
            reference: d.reference,
            customerId: d.customerId || null,
            access: d.access,
            chatUrl: d.chatUrl,
            modules: { chat: d.chat, subtitles: d.subtitles, other: d.other },
            branding: brandingData(form),
          };
          if (d.slug && d.slug !== e.slug) payload.slug = d.slug;
          if (d.accessCode) payload.accessCode = d.accessCode;
          ctx.set(await PATCH("/api/admin/events/" + e.id, payload));
          toast(t("Saved."));
          App.route();
        });
      },
    },
    h("fieldset", { disabled: !editable },
      h("h2", t("Event")),
      h("div.grid2", field(t("Title"), input("title", e.title, { required: true })), field(t("Project reference"), input("reference", e.reference, { required: true }))),
      h("div.grid2",
        field(t("Customer"), select("customerId", [["", t("No customer")], ...customers.map((c) => [c.id, c.name])], e.customerId || "")),
        field(t("Watch link"), input("slug", e.slug, { disabled: e.status !== "draft", pattern: "[a-z0-9-]{3,48}" }), e.status === "draft" ? t("Can only be changed while the event is a draft.") : t("The link is permanent.")),
      ),
      h("h3", t("Access")),
      h("div.grid2",
        field(t("Who can watch"), select("access", [["public", t("Everyone (public)")], ["code", t("With an access code")], ["registration", t("After registration")]], e.access)),
        field(t("Access code"), input("accessCode", "", { type: "text", autocomplete: "off", placeholder: e.hasAccessCode ? t("Set — enter a new code to change it") : t("Not set") })),
      ),
      h("h3", t("Chat and modules")),
      field(t("Chat link (8star Chat)"), input("chatUrl", e.chatUrl, { type: "url", placeholder: "https://chat.example.com/e/…" }), t("The chat is shown next to the player before and during the live phase, in the viewer's language.")),
      h("div.checks", checkbox("chat", t("Chat"), e.modules.chat), checkbox("subtitles", t("Subtitles"), e.modules.subtitles)),
      field(t("Other modules (for the usage report)"), input("other", e.modules.other)),
      h("h3", t("Branding")),
      brandingFields(e.branding),
      editable ? h("div.actions", h("button.primary", { type: "submit" }, t("Save"))) : null,
    ),
  );
  const share = h(
    "section.card",
    h("h2", t("Link and embed code")),
    h("p.muted", t("One permanent link for the pre phase, live, after live and VOD. Add ?lang=en for a direct link to a language.")),
    field(t("Watch link"), h("div.input-row", input("w", e.watchUrl, { readonly: true }), h("button.secondary", { type: "button", onclick: () => copyText(e.watchUrl) }, t("Copy")))),
    field(t("Embed code"), h("div.input-row", textarea("embed", e.embedCode, { rows: 3, readonly: true }), h("button.secondary", { type: "button", onclick: () => copyText(e.embedCode) }, t("Copy")))),
  );
  const danger = editable
    ? h(
        "section.card",
        h("h2", t("Copy or delete")),
        h(
          "div.actions",
          h(
            "button.secondary",
            {
              onclick: () =>
                dialog(
                  t("Copy event"),
                  [
                    h("p.muted", t("Copies sessions, languages, stream settings, media, pages, the registration form and branding. Registrations, VODs and usage are not copied.")),
                    field(t("Title of the copy"), input("title", e.title, { required: true })),
                    field(t("Move dates by (days)"), input("shiftDays", "0", { type: "number", step: 1 })),
                  ],
                  [
                    {
                      label: t("Copy"),
                      primary: true,
                      run: (close, f) =>
                        act(null, async () => {
                          const b = await POST("/api/admin/events/" + e.id + "/copy", formData(f));
                          close();
                          location.hash = "#/events/" + b.event.id;
                        }),
                    },
                  ],
                ),
            },
            t("Copy event"),
          ),
          e.status === "archived"
            ? h(
                "button.danger",
                {
                  onclick: () =>
                    dialog(
                      t("Delete event permanently"),
                      [
                        h("p", t("This deletes the event with its sessions, pages, registrations and usage. Export what you need first. This cannot be undone.")),
                        field(t("Type the project reference ({ref}) to confirm", { ref: e.reference }), input("confirm", "", { required: true, autocomplete: "off" })),
                      ],
                      [
                        {
                          label: t("Delete permanently"),
                          primary: true,
                          danger: true,
                          run: (close, f) =>
                            act(null, async () => {
                              await DELETE("/api/admin/events/" + e.id + qs({ confirm: formData(f).confirm }));
                              close();
                              location.hash = "#/events";
                            }),
                        },
                      ],
                    ),
                },
                t("Delete permanently"),
              )
            : h("span.muted.small", t("Archive the event to be able to delete it.")),
        ),
      )
    : null;
  add(body, h("section.card", h("h2", t("Status")), statusButtons), share, form, danger);
};

// ---- Sessions ---------------------------------------------------------------------------
EventTabs.sessions = async (body, ctx) => {
  const editable = can("events.edit");
  const render = () => {
    const b = ctx.bundle;
    fill(body, 
      h("div.title-row", h("h2", t("Sessions")), editable ? h("button.primary", { onclick: () => edit() }, t("Add session")) : null),
      h("p.muted", t("Days, sessions and rooms. Changing dates and times never changes the watch link.")),
      table(
        [
          { label: t("Title"), value: (s) => h("strong", s.title) },
          { label: t("Room"), value: (s) => s.room || "—" },
          { label: t("Start"), value: (s) => fmtDateTime(s.startAt) },
          { label: t("End"), value: (s) => fmtDateTime(s.endAt) },
          { label: t("Phase"), value: (s) => [phasePill(s.phase), s.phaseOverride ? h("small.muted", " " + t("(manual)")) : null] },
          editable
            ? {
                label: "",
                value: (s) =>
                  h(
                    "div.row-actions",
                    h("button.link", { onclick: () => edit(s) }, t("Edit")),
                    h("button.link", { onclick: () => copy(s) }, t("Copy")),
                    b.sessions.length > 1
                      ? h(
                          "button.link.danger",
                          {
                            onclick: async () => {
                              if (!(await confirmDialog(t("Delete session"), t("Delete {name} with its stream settings, media and VOD?", { name: s.title }), t("Delete"), true))) return;
                              act(null, async () => {
                                ctx.set(await DELETE("/api/admin/sessions/" + s.id));
                                render();
                              });
                            },
                          },
                          t("Delete"),
                        )
                      : null,
                  ),
              }
            : null,
        ].filter(Boolean),
        b.sessions,
      ),
    );
  };
  const edit = (s = null) =>
    dialog(
      s ? t("Edit session") : t("Add session"),
      [
        field(t("Title"), input("title", s?.title, { required: true })),
        field(t("Description"), textarea("description", s?.description, { rows: 3 })),
        field(t("Room or location"), input("room", s?.room)),
        h(
          "div.grid2",
          field(t("Start"), input("startAt", toLocalInput(s?.startAt || ctx.bundle.sessions.at(-1)?.endAt), { type: "datetime-local", required: true })),
          field(t("End"), input("endAt", toLocalInput(s?.endAt || new Date(Date.parse(ctx.bundle.sessions.at(-1)?.endAt || Date.now()) + 3600e3).toISOString()), { type: "datetime-local", required: true })),
        ),
      ],
      [
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              const d = formData(f);
              const payload = { ...d, startAt: fromLocalInput(d.startAt), endAt: fromLocalInput(d.endAt) };
              ctx.set(s ? await PATCH("/api/admin/sessions/" + s.id, payload) : await POST("/api/admin/events/" + ctx.id + "/sessions", payload));
              close();
              render();
            }),
        },
      ],
    );
  const copy = (s) =>
    dialog(
      t("Copy session"),
      [field(t("Title of the copy"), input("title", s.title, { required: true })), field(t("Move dates by (days)"), input("shiftDays", "1", { type: "number", step: 1 }))],
      [
        {
          label: t("Copy"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              ctx.set(await POST("/api/admin/sessions/" + s.id + "/copy", formData(f)));
              close();
              render();
            }),
        },
      ],
    );
  render();
};

// ---- Languages ----------------------------------------------------------------------------
EventTabs.languages = async (body, ctx) => {
  const editable = can("events.edit");
  const render = () => {
    const b = ctx.bundle;
    fill(body, 
      h("div.title-row", h("h2", t("Languages")), editable ? h("button.primary", { onclick: addLanguage }, t("Add language")) : null),
      h("p.muted", t("Each language has its own streams, media, page texts and VOD. Viewers only see active languages. Direct link: add ?lang=<code> to the watch link.")),
      table(
        [
          { label: t("Language"), value: (l) => [h("strong", l.name), " ", h("code", l.code), l.isDefault ? [" ", pill(t("Default"), "info")] : null] },
          { label: t("Status"), value: (l) => (l.active ? pill(t("Active"), "ok") : pill(t("Inactive"), "muted")) },
          { label: t("Direct link"), value: (l) => h("button.link", { onclick: () => copyText(b.event.watchUrl + "?lang=" + l.code) }, t("Copy link")) },
          editable
            ? {
                label: "",
                value: (l) =>
                  h(
                    "div.row-actions",
                    h(
                      "button.link",
                      {
                        onclick: () =>
                          act(null, async () => {
                            ctx.set(await PATCH("/api/admin/languages/" + l.id, { active: !l.active }));
                            render();
                          }),
                        disabled: l.isDefault,
                      },
                      l.active ? t("Deactivate") : t("Activate"),
                    ),
                    !l.isDefault && l.active
                      ? h(
                          "button.link",
                          {
                            onclick: () =>
                              act(null, async () => {
                                ctx.set(await PATCH("/api/admin/languages/" + l.id, { isDefault: true }));
                                render();
                              }),
                          },
                          t("Make default"),
                        )
                      : null,
                    h(
                      "button.link",
                      {
                        onclick: () =>
                          dialog(
                            t("Rename language"),
                            [field(t("Name"), input("name", l.name, { required: true }))],
                            [
                              {
                                label: t("Save"),
                                primary: true,
                                run: (close, f) =>
                                  act(null, async () => {
                                    ctx.set(await PATCH("/api/admin/languages/" + l.id, formData(f)));
                                    close();
                                    render();
                                  }),
                              },
                            ],
                          ),
                      },
                      t("Rename"),
                    ),
                    !l.isDefault
                      ? h(
                          "button.link.danger",
                          {
                            onclick: async () => {
                              if (!(await confirmDialog(t("Delete language"), t("Delete {name} with its streams, media, page texts and VOD settings?", { name: l.name }), t("Delete"), true))) return;
                              act(null, async () => {
                                ctx.set(await DELETE("/api/admin/languages/" + l.id));
                                render();
                              });
                            },
                          },
                          t("Delete"),
                        )
                      : null,
                  ),
              }
            : null,
        ].filter(Boolean),
        b.languages,
      ),
    );
  };
  const addLanguage = () =>
    dialog(
      t("Add language"),
      [
        h("div.grid2", field(t("Language code"), input("code", "", { required: true, placeholder: "en", pattern: "[a-z]{2,3}(-[a-z0-9]{2,8})?" })), field(t("Name"), input("name", "", { required: true, placeholder: "English" }))),
        field(t("Copy settings from"), select("copyFrom", [["", t("Nothing (empty)")], ...ctx.bundle.languages.map((l) => [l.id, l.name])], ""), t("Copies streams, media, page texts (as draft) and form texts. Adjust them afterwards.")),
        h("p.muted.small", t("A new language starts inactive. Activate it when it is ready.")),
      ],
      [
        {
          label: t("Add"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              ctx.set(await POST("/api/admin/events/" + ctx.id + "/languages", formData(f)));
              close();
              render();
            }),
        },
      ],
    );
  render();
};

// ---- Streams ---------------------------------------------------------------------------------
EventTabs.streams = async (body, ctx) => {
  const providers = App.meta.providers;
  const render = () => {
    const b = ctx.bundle;
    fill(body, 
      h("h2", t("Streams")),
      h("p.muted", t("Per session and language a primary and a backup route. They may use different encoders and providers. Viewers get the active route; switching happens in Live control.")),
    );
    for (const s of b.sessions) {
      const card = h("section.card", h("h3", s.title, " ", h("small.muted", fmtDateTime(s.startAt) + (s.room ? " · " + s.room : ""))));
      for (const l of b.languages) {
        const v = b.variants.find((x) => x.sessionId === s.id && x.languageId === l.id);
        const row = h("div.route-pair", h("h4", l.name, " ", h("code", l.code), l.active ? null : [" ", pill(t("Inactive"), "muted")]));
        for (const slot of ["primary", "backup"]) {
          const rt = b.routes.find((x) => x.sessionId === s.id && x.languageId === l.id && x.slot === slot);
          add(row, routeCard(s, l, slot, rt, v?.activeSlot === slot));
        }
        add(card, row);
      }
      add(body, card);
    }
  };
  const routeCard = (s, l, slot, rt, active) =>
    h(
      "div.route" + (active ? ".active" : ""),
      h("div.route-head", h("strong", slot === "primary" ? t("Primary") : t("Backup")), active ? pill(t("Active"), "info") : null, signalPill(rt)),
      rt
        ? h(
            "dl.kv",
            h("dt", t("Provider")),
            h("dd", providers.find((p) => p.id === rt.provider)?.label || rt.provider),
            h("dt", t("Ingest")),
            h("dd", rt.ingestUrl ? h("code.break", rt.ingestUrl) : "—"),
            h("dt", t("Stream key")),
            h("dd", rt.streamKey ? h("button.link", { onclick: () => copyText(rt.streamKey) }, t("Copy stream key")) : "—"),
            h("dt", t("Playback")),
            h("dd", rt.playbackUrl ? h("code.break", rt.playbackUrl) : "—"),
            h("dt", t("Bitrate")),
            h("dd", fmtNumber(rt.bitrateKbps) + " kbps"),
            rt.signalDetail ? [h("dt", t("Status")), h("dd", t(rt.signalDetail))] : null,
          )
        : h("p.muted.small", t("No route set.")),
      h(
        "div.row-actions",
        h("button.secondary", { onclick: () => editRoute(s, l, slot, rt) }, rt ? t("Edit") : t("Set up")),
        rt
          ? h(
              "button.secondary",
              {
                onclick: (e) =>
                  act(e.currentTarget, async () => {
                    const out = await POST("/api/admin/routes/" + rt.id + "/check");
                    toast(out.signal === "ok" ? t("Signal received.") : t("No signal") + (out.signalDetail ? ": " + t(out.signalDetail) : ""), out.signal === "ok" ? "ok" : "error");
                    await ctx.reload();
                    render();
                  }),
              },
              t("Check signal"),
            )
          : null,
        rt
          ? h(
              "button.link.danger",
              {
                onclick: async () => {
                  if (!(await confirmDialog(t("Remove route"), t("Remove this route?"), t("Remove"), true))) return;
                  act(null, async () => {
                    ctx.set(await DELETE("/api/admin/routes/" + rt.id));
                    render();
                  });
                },
              },
              t("Remove"),
            )
          : null,
      ),
    );
  const editRoute = (s, l, slot, rt) => {
    const fieldsBox = h("div");
    const providerSel = select("provider", providers.map((p) => [p.id, p.label]), rt?.provider || "hls");
    const showFields = () => {
      const p = providers.find((x) => x.id === providerSel.value);
      fill(fieldsBox, 
        p.fields.map((f) => field(t(f.label), input("cfg_" + f.key, rt?.provider === p.id ? rt.config[f.key] : "", { type: f.secret ? "password" : "text", autocomplete: "off" }))),
      );
    };
    providerSel.addEventListener("change", showFields);
    showFields();
    dialog(
      t("{slot} route · {session} · {language}", { slot: slot === "primary" ? t("Primary") : t("Backup"), session: s.title, language: l.name }),
      [
        field(t("Provider"), providerSel),
        fieldsBox,
        field(t("Bitrate (kbps)"), input("bitrateKbps", rt?.bitrateKbps || 3000, { type: "number", min: 100, max: 50000 }), t("Used to estimate data volume (GB) from the number of viewers.")),
      ],
      [
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              const d = formData(f);
              const config = {};
              for (const [k, v] of Object.entries(d)) if (k.startsWith("cfg_")) config[k.slice(4)] = v;
              ctx.set(await PUT("/api/admin/sessions/" + s.id + "/languages/" + l.id + "/routes/" + slot, { provider: d.provider, config, bitrateKbps: Number(d.bitrateKbps) }));
              close();
              render();
            }),
        },
      ],
    );
  };
  render();
};

// ---- Live control ------------------------------------------------------------------------------
// Shared alarm: a short tone every few seconds while the active route of a
// live language has no signal, until it is acknowledged.
const Alarm = {
  ctx: null,
  muted: new Set(),
  beep() {
    try {
      this.ctx ||= new AudioContext();
      const o = this.ctx.createOscillator(),
        g = this.ctx.createGain();
      o.type = "square";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.6);
      o.connect(g).connect(this.ctx.destination);
      o.start();
      o.stop(this.ctx.currentTime + 0.6);
    } catch {}
  },
};

EventTabs.live = async (body, ctx) => {
  const banner = h("div.alarm", { role: "alert", hidden: true });
  const box = h("div");
  let last = null;
  const soundNote = h("p.muted.small", t("Sound alarms need one click on this page first (browser rule)."));
  document.addEventListener("click", () => Alarm.ctx?.resume?.(), { once: true });
  const render = (live) => {
    last = live;
    const alarms = [];
    fill(box, 
      h(
        "div.live-summary",
        h("div.stat", h("span", t("Viewers now")), h("strong", fmtNumber(live.viewers))),
        h("div.stat", h("span", t("Event status")), statusPill(live.status)),
        h("div.stat", h("span", t("Updated")), h("strong", fmtTime(live.now))),
      ),
    );
    for (const s of live.sessions) {
      const phaseSel = select(
        "phase",
        [["", t("Automatic (schedule)")], ...Object.entries(PHASE_LABEL())],
        s.phaseOverride || "",
        { disabled: live.status !== "scheduled", "aria-label": t("Phase") },
      );
      phaseSel.addEventListener("change", async () => {
        const value = phaseSel.value || null;
        const label = value ? PHASE_LABEL()[value] : t("Automatic (schedule)");
        if (!(await confirmDialog(t("Change phase"), t("Change the phase of {s} to {p}? Viewers see the change within seconds.", { s: s.title, p: label }), t("Change phase")))) {
          phaseSel.value = s.phaseOverride || "";
          return;
        }
        act(null, async () => {
          await POST("/api/admin/sessions/" + s.id + "/phase", { phase: value });
          refresh();
        });
      });
      const card = h(
        "section.card.live-session",
        h(
          "div.title-row",
          h("h3", s.title, " ", phasePill(s.phase)),
          h("div.muted", fmtDateTime(s.startAt) + " – " + fmtTime(s.endAt) + (s.room ? " · " + s.room : "")),
        ),
        h("div.phase-row", h("label", t("Phase")), phaseSel, live.status !== "scheduled" ? h("small.muted", t("Manual phase changes are possible when the event is Scheduled.")) : null),
      );
      const rows = s.languages.map((l) => {
        if (l.warning) alarms.push(s.title + " · " + l.name + ": " + (l.warning === "missing" ? t("no route set") : t("no signal on the active route")));
        return h(
          "tr" + (l.warning ? ".warn" : ""),
          h("td", h("strong", l.name), l.active ? null : [" ", pill(t("Inactive"), "muted")]),
          h("td", phasePill(l.phase)),
          h("td", ["primary", "backup"].map((slot) => h("div.slot" + (l.activeSlot === slot ? ".on" : ""), h("span", slot === "primary" ? t("Primary") : t("Backup")), signalPill(l.routes[slot])))),
          h("td.num", fmtNumber(l.viewers)),
          h(
            "td",
            ["primary", "backup"]
              .filter((slot) => slot !== l.activeSlot)
              .map((slot) =>
                h(
                  "button" + (l.warning ? ".danger" : ".secondary"),
                  { disabled: !l.routes[slot]?.configured, onclick: () => switchRoute(s, l, slot) },
                  t("Switch to {slot}", { slot: slot === "primary" ? t("primary") : t("backup") }),
                ),
              ),
          ),
        );
      });
      add(card, h("div.table-wrap", h("table.live-table", h("thead", h("tr", h("th", t("Language")), h("th", t("Phase")), h("th", t("Routes")), h("th.num", t("Viewers")), h("th", t("Switch")))), h("tbody", rows))));
      add(box, card);
    }
    add(box, 
      h("section.card", h("h3", t("Route switches")), table(
        [
          { label: t("Time"), value: (w) => fmtDateTime(w.at) },
          { label: t("Session"), value: (w) => w.session },
          { label: t("Language"), value: (w) => w.language },
          { label: t("Switch"), value: (w) => (w.from === "primary" ? t("Primary") : t("Backup")) + " → " + (w.to === "primary" ? t("Primary") : t("Backup")) },
          { label: t("Reason"), value: (w) => w.reason },
          { label: t("By"), value: (w) => w.user },
        ],
        live.switches,
        { empty: t("No switches yet.") },
      )),
    );
    // Alarm: visible always, audible until acknowledged.
    const key = alarms.join("|");
    if (alarms.length && live.alarm) {
      banner.hidden = false;
      fill(banner, 
        h("strong", t("Signal lost")),
        h("ul", alarms.map((a) => h("li", a))),
        Alarm.muted.has(key) ? h("span.small", t("Sound off for this alarm.")) : h("button.secondary", { onclick: () => (Alarm.muted.add(key), render(last)) }, t("Acknowledge (sound off)")),
      );
      if (!Alarm.muted.has(key)) Alarm.beep();
    } else if (alarms.length) {
      banner.hidden = false;
      fill(banner, h("strong", t("Attention")), h("ul", alarms.map((a) => h("li", a))));
      banner.classList.add("soft");
    } else {
      banner.hidden = true;
      banner.classList.remove("soft");
    }
  };
  const switchRoute = (s, l, to) => {
    const target = l.routes[to];
    dialog(
      t("Switch route"),
      [
        h("p", t("Switch {language} of {session} from {from} to {to}? Viewers move over automatically within seconds.", { language: l.name, session: s.title, from: l.activeSlot === "primary" ? t("primary") : t("backup"), to: to === "primary" ? t("primary") : t("backup") })),
        target?.signal !== "ok" ? h("p.notice.bad", t("Warning: the {slot} route has no confirmed signal.", { slot: to === "primary" ? t("primary") : t("backup") })) : null,
        field(t("Reason"), input("reason", "", { required: true, minlength: 3, placeholder: t("e.g. no picture on primary encoder") })),
      ],
      [
        {
          label: t("Switch now"),
          primary: true,
          danger: true,
          run: (close, f) =>
            act(null, async () => {
              render(await POST("/api/admin/sessions/" + s.id + "/languages/" + l.languageId + "/switch", { to, reason: formData(f).reason }));
              close();
              toast(t("Route switched."));
            }),
        },
      ],
    );
  };
  const refresh = async () => render(await GET("/api/admin/events/" + ctx.id + "/live"));
  add(body, banner, soundNote, box);
  await refresh();
  every(3000, () => refresh().catch(() => {}));
};

// ---- Green Room --------------------------------------------------------------------------------
EventTabs.greenroom = async (body, ctx) => {
  const b = ctx.bundle;
  const video = h("video.player", { controls: true, playsinline: true, autoplay: true });
  const status = h("div.gr-status");
  const sessSel = select("session", b.sessions.map((s) => [s.id, s.title + " · " + fmtDateTime(s.startAt)]), b.sessions[0]?.id);
  const langSel = select("language", b.languages.map((l) => [l.id, l.name]), b.languages[0]?.id);
  const slotSel = select("slot", [["primary", t("Primary")], ["backup", t("Backup")]], "primary");
  const show = async () => {
    const live = await GET("/api/admin/events/" + ctx.id + "/live");
    const s = live.sessions.find((x) => x.id === sessSel.value);
    const l = s?.languages.find((x) => x.languageId === langSel.value);
    const rt = l?.routes[slotSel.value];
    fill(status, 
      signalPill(rt),
      " ",
      l ? h("span", t("Active route for viewers: {slot}", { slot: l.activeSlot === "primary" ? t("primary") : t("backup") })) : null,
      " · ",
      l ? phasePill(l.phase) : null,
    );
    return rt;
  };
  const play = async () => {
    const rt = await show();
    let warned = false;
    attachVideo(video, rt?.playbackUrl || "", {
      onError: (data) => {
        console.warn("player", data?.details || data);
        if (!warned) toast(t("The player cannot load this stream (yet)."), "error");
        warned = true;
      },
    });
    video.muted = false;
    video.play?.().catch(() => {});
  };
  for (const s of [sessSel, langSel, slotSel]) s.addEventListener("change", play);
  App.onLeave = () => attachVideo(video, "");
  add(body, 
    h("div.notice.info", h("strong", t("Not publicly visible.")), " ", t("This preview is only available to administrators and technicians. Viewers do not get the stream address before the live phase.")),
    h("div.toolbar", field(t("Session"), sessSel), field(t("Language"), langSel), field(t("Route"), slotSel)),
    status,
    h("div.player-wrap", video),
    h("p.muted.small", t("Picture and sound are played directly from the playback URL of the route. A switch can be tested in Live control while the event is in Test.")),
    can("live") ? h("p", h("a.button.secondary", { href: "#/events/" + ctx.id + "/live" }, t("Open live control"))) : null,
  );
  await play();
  every(5000, () => show().catch(() => {}));
};

EventTabs.usage = async (body, ctx) => usageView(body, { event: ctx.id });
