// Admin views: dashboard, customers, users, environments, templates, media,
// usage, audit log, settings.
"use strict";

// Environment chooser for the platform (resellers always work in their own).
function tenantSelect(name = "tenantId", value) {
  if (!App.me.platform) return null;
  const list = App.meta.tenants.filter((x) => x.status === "active");
  return field(t("Environment"), select(name, list.map((x) => [x.id, x.name]), value || App.me.tenantId));
}

// ---- Dashboard ---------------------------------------------------------------
App.views.dashboard = async (main) => {
  add(main, h("h1", t("Dashboard")));
  const box = h("div.dash");
  add(main, box);
  const load = async () => {
    const d = await GET("/api/admin/dashboard");
    const evLink = (x, extra) => h("a", { href: "#/events/" + x.eventId + (extra || "") }, x.eventTitle);
    const card = (title, items, render, kind = "") =>
      h("section.card" + (kind && items.length ? "." + kind : ""), h("h2", title, " ", h("span.count", String(items.length))), items.length ? h("ul.list", items.map((x) => h("li", render(x)))) : h("p.empty", t("Nothing here.")));
    fill(box, 
      card(
        t("Signal warnings"),
        d.warnings,
        (w) => [
          evLink(w, "/live"),
          " · ",
          w.sessionTitle,
          " · ",
          w.language,
          " · ",
          w.slot === "primary" ? t("Primary") : t("Backup"),
          w.active ? [" ", pill(t("Active route"), "bad")] : null,
          h("div.muted.small", t(w.detail || "No signal") + " · " + t("since") + " " + fmtTime(w.since)),
        ],
        "alert",
      ),
      card(t("Live now"), d.live, (x) => [evLink(x, "/live"), " · ", x.sessionTitle, h("div.muted.small", t("{n} viewers", { n: fmtNumber(x.viewers) }) + " · " + t("until") + " " + fmtTime(x.endAt))]),
      card(t("In test"), d.testing, (x) => [h("a", { href: "#/events/" + x.id + "/greenroom" }, x.title), " · ", x.reference]),
      card(t("Coming up (7 days)"), d.upcoming, (x) => [evLink(x), " · ", x.sessionTitle, h("div.muted.small", fmtDateTime(x.startAt) + " · " + STATUS_LABEL()[x.status])]),
      card(t("Registrations to approve"), d.pendingRegistrations, (x) => [h("a", { href: "#/events/" + x.id + "/registrations" }, x.title), " · ", t("{n} pending", { n: x.n })]),
      card(t("VOD to publish"), d.vodTodo, (x) => [evLink(x, "/vod"), " · ", x.sessionTitle, h("div.muted.small", x.languages.join(", "))]),
      card(t("VOD expiring within 14 days"), d.expiring, (x) => [evLink(x, "/vod"), " · ", x.sessionTitle, " · ", x.language, h("div.muted.small", t("Expires") + " " + fmtDate(x.expireAt))]),
    );
  };
  await load();
  every(15000, () => load().catch(() => {}));
};

// ---- Customers ----------------------------------------------------------------
App.views.customers = async (main, [id]) => {
  if (id) return customerDetail(main, id);
  const list = await GET("/api/admin/customers");
  const addCustomer = () => {
    const d = dialog(
      t("New customer"),
      [
        tenantSelect(),
        field(t("Name"), input("name", "", { required: true })),
        field(t("Account manager"), input("accountManagerName")),
        field(t("Account manager email"), input("accountManagerEmail", "", { type: "email" })),
      ],
      [
        {
          label: t("Create"),
          primary: true,
          run: (close, form) =>
            act(null, async () => {
              const c = await POST("/api/admin/customers", formData(form));
              close();
              location.hash = "#/customers/" + c.id;
            }),
        },
      ],
    );
  };
  add(main, 
    h("div.title-row", h("h1", t("Customers")), h("button.primary", { onclick: addCustomer }, t("New customer"))),
    table(
      [
        { label: t("Name"), value: (c) => h("a", { href: "#/customers/" + c.id }, c.name) },
        App.me.platform ? { label: t("Environment"), value: (c) => c.tenantName } : null,
        { label: t("Account manager"), value: (c) => c.accountManagerName || "—" },
        { label: t("Events"), value: (c) => String(c.events), class: "num" },
        { label: t("Status"), value: (c) => (c.status === "archived" ? pill(t("Archived"), "muted") : pill(t("Active"), "ok")) },
      ].filter(Boolean),
      list,
      { onRow: (c) => (location.hash = "#/customers/" + c.id), empty: t("No customers yet.") },
    ),
  );
};

async function customerDetail(main, id) {
  const c = await GET("/api/admin/customers/" + id);
  const form = h(
    "form.card",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        act(form.querySelector("button[type=submit]"), async () => {
          await PATCH("/api/admin/customers/" + id, {
            name: d.name,
            accountManagerName: d.accountManagerName,
            accountManagerEmail: d.accountManagerEmail,
            branding: brandingData(form),
          });
          toast(t("Saved."));
        });
      },
    },
    h("h2", t("Customer details")),
    field(t("Name"), input("name", c.name, { required: true })),
    h("div.grid2", field(t("Account manager"), input("accountManagerName", c.accountManagerName)), field(t("Account manager email"), input("accountManagerEmail", c.accountManagerEmail, { type: "email" }))),
    h("h3", t("Default branding")),
    h("p.muted.small", t("Applied to new events of this customer; each event can then be changed.")),
    brandingFields(c.branding),
    h("div.actions", h("button.primary", { type: "submit" }, t("Save"))),
  );
  const contacts = h("section.card");
  const renderContacts = (list) => {
    fill(contacts, 
      h("div.title-row", h("h2", t("Contacts")), h("button.secondary", { onclick: () => contactDialog() }, t("Add contact"))),
      table(
        [
          { label: t("Name"), value: (x) => x.name },
          { label: t("Function"), value: (x) => x.function || "—" },
          { label: t("Email"), value: (x) => x.email },
          { label: t("Phone"), value: (x) => x.phone || "—" },
          { label: t("Language"), value: (x) => x.language },
          {
            label: "",
            value: (x) =>
              h(
                "div.row-actions",
                h("button.link", { onclick: () => contactDialog(x) }, t("Edit")),
                h(
                  "button.link.danger",
                  {
                    onclick: async () => {
                      if (!(await confirmDialog(t("Delete contact"), t("Delete {name}?", { name: x.name }), t("Delete"), true))) return;
                      await act(null, async () => {
                        await DELETE("/api/admin/contacts/" + x.id);
                        renderContacts((await GET("/api/admin/customers/" + id)).contacts);
                      });
                    },
                  },
                  t("Delete"),
                ),
              ),
          },
        ],
        list,
        { empty: t("No contacts yet.") },
      ),
    );
  };
  const contactDialog = (x = {}) =>
    dialog(
      x.id ? t("Edit contact") : t("Add contact"),
      [
        field(t("Name"), input("name", x.name, { required: true })),
        field(t("Function"), input("function", x.function)),
        field(t("Email"), input("email", x.email, { type: "email", required: true })),
        field(t("Phone"), input("phone", x.phone, { type: "tel" })),
        field(t("Preferred language"), select("language", [["nl", "Nederlands"], ["en", "English"], ["de", "Deutsch"], ["fr", "Français"]], x.language || "nl")),
      ],
      [
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              if (x.id) await PATCH("/api/admin/contacts/" + x.id, formData(f));
              else await POST("/api/admin/customers/" + id + "/contacts", formData(f));
              close();
              renderContacts((await GET("/api/admin/customers/" + id)).contacts);
            }),
        },
      ],
    );
  renderContacts(c.contacts);
  const archive = h(
    "button.secondary",
    {
      onclick: (e) =>
        act(e.currentTarget, async () => {
          await PATCH("/api/admin/customers/" + id, { status: c.status === "archived" ? "active" : "archived" });
          App.route();
        }),
    },
    c.status === "archived" ? t("Restore") : t("Archive"),
  );
  add(main, 
    h("p.crumbs", h("a", { href: "#/customers" }, t("Customers"))),
    h("div.title-row", h("h1", c.name, " ", c.status === "archived" ? pill(t("Archived"), "muted") : null), archive),
    form,
    contacts,
  );
}

// Branding fields (customer and event): title, logo, colours, background.
function brandingFields(b = {}) {
  const imageField = (name, label) => {
    const inp = input(name, b[name], { placeholder: "https://… " + t("or choose from media") });
    return field(
      label,
      h(
        "div.input-row",
        inp,
        h(
          "button.secondary",
          {
            type: "button",
            onclick: async () => {
              const url = await pickMedia();
              if (url) inp.value = url;
            },
          },
          t("Choose"),
        ),
      ),
    );
  };
  const color = (name, label, fallback) => field(label, input(name, b[name] || fallback, { type: "color" }));
  return h(
    "div.branding",
    field(t("Page title"), input("pageTitle", b.title)),
    imageField("logo", t("Logo")),
    imageField("background", t("Background image")),
    h("div.grid3", color("primary", t("Accent colour"), "#c8102e"), color("backgroundColor", t("Background colour"), "#f5f5f7"), color("text", t("Text colour"), "#1d1d1f")),
  );
}
const brandingData = (form) => {
  const d = formData(form);
  return { title: d.pageTitle, logo: d.logo, background: d.background, primary: d.primary, backgroundColor: d.backgroundColor, text: d.text };
};

// ---- Users ----------------------------------------------------------------------
App.views.users = async (main) => {
  const list = await GET("/api/admin/users");
  const roles = Object.entries(ROLE_LABEL());
  const edit = (u = null) =>
    dialog(
      u ? t("Edit user") : t("New user"),
      [
        u ? null : tenantSelect(),
        u ? h("p", h("strong", u.email)) : field(t("Email address"), input("email", "", { type: "email", required: true })),
        field(t("Name"), input("name", u?.name)),
        field(t("Role"), select("role", roles, u?.role || "technician")),
        h(
          "ul.small.muted.role-help",
          h("li", t("Administrator: everything within the environment.")),
          h("li", t("Technician: streams, Green Room, live control and phases.")),
          h("li", t("Content manager: watch page, templates, media, registration and VOD.")),
        ),
        field(u ? t("New password (optional)") : t("Password"), input("password", "", { type: "password", autocomplete: "new-password", minlength: 12, required: !u }), t("At least 12 characters. Share it with the user in a safe way.")),
        u ? checkbox("active", t("Active"), u.active) : null,
      ],
      [
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              const d = formData(f);
              if (u) await PATCH("/api/admin/users/" + u.id, { name: d.name, role: d.role, active: d.active, password: d.password || undefined });
              else await POST("/api/admin/users", d);
              close();
              App.route();
            }),
        },
      ],
    );
  add(main, 
    h("div.title-row", h("h1", t("Users")), h("button.primary", { onclick: () => edit() }, t("New user"))),
    table(
      [
        { label: t("Email"), value: (u) => u.email },
        { label: t("Name"), value: (u) => u.name || "—" },
        App.me.platform ? { label: t("Environment"), value: (u) => u.tenantName } : null,
        { label: t("Role"), value: (u) => ROLE_LABEL()[u.role] },
        { label: t("Last sign-in"), value: (u) => fmtDateTime(u.lastLogin) },
        { label: t("Status"), value: (u) => (u.active ? pill(t("Active"), "ok") : pill(t("Disabled"), "muted")) },
      ].filter(Boolean),
      list,
      { onRow: edit },
    ),
  );
};

// ---- Environments (platform) --------------------------------------------------
App.views.tenants = async (main) => {
  const list = await GET("/api/admin/tenants");
  const statusLabel = { active: t("Active"), blocked: t("Blocked"), archived: t("Archived") };
  const edit = (x = null) =>
    dialog(
      x ? t("Edit environment") : t("New reseller environment"),
      [
        field(t("Name"), input("name", x?.name, { required: true })),
        x && x.kind !== "platform"
          ? field(t("Status"), select("status", Object.entries(statusLabel), x.status), t("Blocked and archived environments cannot sign in; their watch pages stay online."))
          : null,
      ],
      [
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              if (x) await PATCH("/api/admin/tenants/" + x.id, formData(f));
              else await POST("/api/admin/tenants", formData(f));
              App.meta = await GET("/api/admin/meta");
              close();
              App.route();
            }),
        },
      ],
    );
  add(main, 
    h("div.title-row", h("h1", t("Environments")), h("button.primary", { onclick: () => edit() }, t("New reseller environment"))),
    h("p.muted", t("A reseller only sees its own customers, users, events, registrations, media, templates and reports.")),
    table(
      [
        { label: t("Name"), value: (x) => x.name },
        { label: t("Type"), value: (x) => (x.kind === "platform" ? t("Platform") : t("Reseller")) },
        { label: t("Users"), value: (x) => String(x.users), class: "num" },
        { label: t("Customers"), value: (x) => String(x.customers), class: "num" },
        { label: t("Events"), value: (x) => String(x.events), class: "num" },
        { label: t("Status"), value: (x) => pill(statusLabel[x.status], x.status === "active" ? "ok" : "muted") },
      ],
      list,
      { onRow: edit },
    ),
  );
};

// ---- Templates -------------------------------------------------------------------
App.views.templates = async (main) => {
  const list = await GET("/api/admin/templates");
  const edit = (x = null) => {
    const editor = createEditor(x?.html || "");
    dialog(
      x ? t("Edit template") : t("New template"),
      [
        field(t("Name"), input("name", x?.name, { required: true })),
        !x && can("templates.central") ? checkbox("central", t("Central template (available to all environments)"), false) : null,
        editor.el,
      ],
      [
        x
          ? {
              label: t("Delete"),
              danger: true,
              run: async (close) => {
                if (!(await confirmDialog(t("Delete template"), t("Delete {name}?", { name: x.name }), t("Delete"), true))) return;
                act(null, async () => {
                  await DELETE("/api/admin/templates/" + x.id);
                  close();
                  App.route();
                });
              },
            }
          : null,
        {
          label: t("Save"),
          primary: true,
          run: (close, f) =>
            act(null, async () => {
              const d = formData(f);
              if (x) await PATCH("/api/admin/templates/" + x.id, { name: d.name, html: editor.html() });
              else await POST("/api/admin/templates", { name: d.name, central: d.central, html: editor.html() });
              close();
              App.route();
            }),
        },
      ].filter(Boolean),
      { wide: true },
    );
  };
  add(main, 
    h("div.title-row", h("h1", t("Templates")), h("button.primary", { onclick: () => edit() }, t("New template"))),
    h("p.muted", t("Templates are starting points for watch page content. Apply one in the page editor and adjust it there.")),
    table(
      [
        { label: t("Name"), value: (x) => x.name },
        { label: t("Available to"), value: (x) => (x.central ? pill(t("Everyone (central)"), "info") : x.tenantName) },
        { label: t("Created by"), value: (x) => x.createdBy },
        { label: t("Created"), value: (x) => fmtDate(x.createdAt) },
      ],
      list,
      { onRow: (x) => (x.central && !can("templates.central") ? toast(t("Only the platform can change central templates."), "error") : edit(x)) },
    ),
  );
};

// ---- Media -------------------------------------------------------------------------
App.views.media = async (main) => {
  const list = await GET("/api/admin/media");
  const upload = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true });
  upload.addEventListener("change", () =>
    act(null, async () => {
      for (const f of upload.files) await uploadMedia(f);
      App.route();
    }),
  );
  add(main, 
    h("div.title-row", h("h1", t("Media")), h("label.button.primary", t("Upload images"), upload)),
    h("p.muted", t("PNG, JPG, WebP or GIF, up to {mb} MB. Videos are added by address (HLS or MP4) at the session and VOD settings.", { mb: 10 })),
    list.length
      ? h(
          "div.media-grid",
          list.map((m) =>
            h(
              "div.media-item",
              h("img", { src: m.url, alt: "", loading: "lazy" }),
              h("span", m.name),
              h("small.muted", fmtNumber(m.size / 1024) + " KB"),
              h(
                "div.row-actions",
                h("button.link", { onclick: () => copyText(location.origin + m.url) }, t("Copy link")),
                h(
                  "button.link.danger",
                  {
                    onclick: async () => {
                      if (!(await confirmDialog(t("Delete image"), t("Pages that use this image will no longer show it. Delete {name}?", { name: m.name }), t("Delete"), true))) return;
                      act(null, async () => {
                        await DELETE("/api/admin/media/" + m.id);
                        App.route();
                      });
                    },
                  },
                  t("Delete"),
                ),
              ),
            ),
          ),
        )
      : h("p.empty", t("No images yet. Upload one.")),
  );
};

// ---- Usage -----------------------------------------------------------------------------
App.views.usage = async (main, [eventId]) => usageView(main, { event: eventId });

async function usageView(main, preset = {}) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const customers = preset.event ? [] : await GET("/api/admin/customers");
  const filters = h(
    "form.filters",
    { onsubmit: (e) => (e.preventDefault(), run()) },
    field(t("From"), input("from", iso(first), { type: "date" })),
    field(t("Up to and including"), input("to", iso(today), { type: "date" })),
    App.me.platform && !preset.event ? field(t("Environment"), select("tenant", [["", t("All")], ...App.meta.tenants.map((x) => [x.id, x.name])], "")) : null,
    !preset.event ? field(t("Customer"), select("customer", [["", t("All")], ...customers.map((c) => [c.id, c.name])], "")) : null,
    h("button.primary", { type: "submit" }, t("Show")),
  );
  const out = h("div");
  const params = () => {
    const d = formData(filters);
    const to = new Date(d.to + "T00:00");
    to.setDate(to.getDate() + 1);
    return { from: new Date(d.from + "T00:00").toISOString(), to: to.toISOString(), tenant: d.tenant, customer: d.customer, event: preset.event };
  };
  const run = () =>
    act(filters.querySelector("button"), async () => {
      const p = params();
      const u = await GET("/api/admin/usage" + qs(p));
      const name = input("name", "", { placeholder: t("File name (optional)") });
      const exp = (format) => download("/api/admin/usage/export" + qs({ ...p, format, lang: App.lang, name: name.value.trim() }));
      fill(out, 
        h(
          "div.toolbar",
          name,
          h("button.secondary", { type: "button", onclick: () => exp("csv") }, t("Download CSV")),
          h("button.secondary", { type: "button", onclick: () => exp("xlsx") }, t("Download Excel")),
        ),
        h("h2", t("Per event")),
        table(
          [
            { label: t("Reference"), value: (x) => x.reference },
            { label: t("Event"), value: (x) => h("a", { href: "#/events/" + x.eventId }, x.title) },
            { label: t("Customer"), value: (x) => x.customer || "—" },
            { label: t("Live minutes"), value: (x) => fmtNumber(x.liveMinutes), class: "num" },
            { label: t("Language stream minutes"), value: (x) => fmtNumber(x.streamMinutes), class: "num" },
            { label: t("Test minutes"), value: (x) => fmtNumber(x.testMinutes), class: "num" },
            { label: t("GB (estimated)"), value: (x) => fmtNumber(x.gb, 2), class: "num" },
            { label: t("Peak viewers"), value: (x) => fmtNumber(x.peak), class: "num" },
            { label: t("Plays"), value: (x) => fmtNumber(x.plays), class: "num" },
            { label: t("Modules"), value: (x) => x.modules.map((m) => t(m)).join(", ") || "—" },
          ],
          u.events,
          { empty: t("No usage in this period.") },
        ),
        h("h2", t("Per session, language and route")),
        table(
          [
            { label: t("Event"), value: (x) => x.reference },
            { label: t("Session"), value: (x) => x.session },
            { label: t("Language"), value: (x) => x.language },
            { label: t("Route"), value: (x) => (x.slot === "primary" ? t("Primary") : t("Backup")) },
            { label: t("Live minutes"), value: (x) => fmtNumber(x.liveMinutes), class: "num" },
            { label: t("Test minutes"), value: (x) => fmtNumber(x.testMinutes), class: "num" },
            { label: t("GB (estimated)"), value: (x) => fmtNumber(x.gb, 2), class: "num" },
            { label: t("Peak viewers"), value: (x) => fmtNumber(x.peak), class: "num" },
          ],
          u.rows,
          { empty: t("No usage in this period.") },
        ),
        h(
          "p.muted.small",
          t("GB is estimated from viewers × bitrate per minute until measured values are fetched from the streaming provider. Storage is not measured yet."),
        ),
      );
    });
  if (!preset.event) add(main, h("h1", t("Usage")));
  add(main, filters, out);
  run();
}

// ---- Audit log -------------------------------------------------------------------------
App.views.audit = async (main) => {
  const out = h("div");
  const filters = h(
    "form.filters",
    { onsubmit: (e) => (e.preventDefault(), run()) },
    field(t("Search"), input("q", "", { type: "search", placeholder: t("User, target or detail") })),
    field(
      t("Action"),
      select(
        "action",
        [
          ["", t("All")],
          ["login", t("Sign-in")],
          ["event.", t("Events")],
          ["session.", t("Sessions and phases")],
          ["language.", t("Languages")],
          ["route.", t("Streams and route switches")],
          ["signal.", t("Signal")],
          ["page.", t("Watch pages")],
          ["form.", t("Registration form")],
          ["registration", t("Registrations")],
          ["vod.", t("VOD")],
          ["user.", t("Users")],
          ["customer.", t("Customers")],
        ],
        "",
      ),
    ),
    field(t("From"), input("from", "", { type: "date" })),
    h("button.primary", { type: "submit" }, t("Show")),
  );
  const run = () =>
    act(filters.querySelector("button"), async () => {
      const d = formData(filters);
      const rows = await GET("/api/admin/audit" + qs({ q: d.q, action: d.action, from: d.from ? new Date(d.from + "T00:00").toISOString() : "" }));
      fill(out, 
        table(
          [
            { label: t("Time"), value: (a) => fmtDateTime(a.at) },
            App.me.platform ? { label: t("Environment"), value: (a) => a.tenant || "—" } : null,
            { label: t("User"), value: (a) => a.user },
            { label: t("Action"), value: (a) => h("code", a.action) },
            { label: t("Detail"), value: (a) => auditDetail(a.detail) },
            { label: t("Result"), value: (a) => (a.result === "ok" ? pill(t("OK"), "ok") : pill(a.result, "bad")) },
          ].filter(Boolean),
          rows,
          { empty: t("No log entries found.") },
        ),
      );
    });
  add(main, h("h1", t("Audit log")), filters, out);
  run();
};
function auditDetail(d) {
  const entries = Object.entries(d || {});
  if (!entries.length) return "—";
  const show = (v) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return h(
    "dl.detail",
    entries.map(([k, v]) => [h("dt", k), h("dd", Array.isArray(v) && v.length === 2 ? [show(v[0]), " → ", show(v[1])] : show(v))]),
  );
}

// ---- Settings (platform) ---------------------------------------------------------------
App.views.settings = async (main) => {
  const s = await GET("/api/admin/settings");
  const form = h(
    "form.card.narrow",
    {
      onsubmit: (e) => {
        e.preventDefault();
        act(form.querySelector("button"), async () => {
          const hosts = form.elements.hosts.value.split(/[\s,]+/).filter(Boolean);
          const out = await PUT("/api/admin/settings", { iframeHosts: hosts });
          form.elements.hosts.value = out.iframeHosts.join("\n");
          App.meta = await GET("/api/admin/meta");
          toast(t("Saved."));
        });
      },
    },
    h("h2", t("Approved iframe sources")),
    h("p.muted", t("Watch pages may only embed content (iframes) from these domains, including their subdomains. One domain per line.")),
    field(t("Domains"), textarea("hosts", s.iframeHosts.join("\n"), { rows: 8 })),
    h("button.primary", { type: "submit" }, t("Save")),
  );
  add(main, h("h1", t("Settings")), form);
};
