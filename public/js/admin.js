// Admin shell: sign-in, navigation, hash router.
"use strict";

const NAV = () => [
  ["dashboard", t("Dashboard"), "events.view"],
  ["events", t("Events"), "events.view"],
  ["customers", t("Customers"), "customers"],
  ["usage", t("Usage"), "usage"],
  ["templates", t("Templates"), "pages"],
  ["media", t("Media"), "pages"],
  ["users", t("Users"), "users"],
  ["tenants", t("Environments"), "tenants"],
  ["audit", t("Audit log"), "audit"],
  ["settings", t("Settings"), "settings"],
];

App.route = async function route() {
  for (const id of App.timers) clearInterval(id);
  App.timers = [];
  App.onLeave?.();
  App.onLeave = null;
  document.documentElement.lang = App.lang;
  const root = $("#app");
  if (!App.me) {
    try {
      const me = await api("GET", "/api/admin/me", undefined, { allow401: true });
      App.me = me.user;
      App.csrf = me.csrf;
      App.meta = await GET("/api/admin/meta");
    } catch {
      return renderLogin(clear(root));
    }
  }
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const name = parts[0] || "dashboard";
  const main = h("main#main", { tabindex: -1 });
  fill(root, layout(name), main);
  const view = App.views[name] || App.views.dashboard;
  try {
    await view(main, parts.slice(1));
  } catch (e) {
    if (e.status === 401) return;
    fill(main, h("div.notice.bad", t(e.message)));
  }
};

function layout(active) {
  const nav = h(
    "nav.side",
    { "aria-label": t("Main menu") },
    h("div.brand", h("strong", "8star"), " Stream"),
    h(
      "ul",
      NAV()
        .filter(([, , perm]) => can(perm))
        .map(([id, label]) => h("li", h("a", { href: "#/" + id, class: id === active ? "active" : "", "aria-current": id === active ? "page" : undefined }, label))),
    ),
    h(
      "div.who",
      h("div", h("strong", App.me.name || App.me.email)),
      h("div.muted", App.me.tenantName + " · " + ROLE_LABEL()[App.me.role]),
      h(
        "div.who-actions",
        h("a", { href: "#/account" }, t("Account")),
        h(
          "button.link",
          {
            onclick: async () => {
              await POST("/api/admin/logout").catch(() => {});
              App.me = null;
              App.csrf = "";
              location.hash = "";
              App.route();
            },
          },
          t("Sign out"),
        ),
      ),
    ),
  );
  const toggle = h("button.menu-toggle", { "aria-label": t("Menu"), onclick: () => document.body.classList.toggle("nav-open") }, "☰");
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a")) document.body.classList.remove("nav-open");
  });
  return h("div.shell-nav", toggle, nav);
}

function renderLogin(root) {
  const err = h("p.error", { role: "alert" });
  const form = h(
    "form.login",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        const b = form.querySelector("button");
        b.disabled = true;
        try {
          const out = await api("POST", "/api/admin/login", formData(form), { allow401: true });
          App.me = out.user;
          App.csrf = out.csrf;
          App.meta = await GET("/api/admin/meta");
          App.route();
        } catch (e2) {
          err.textContent = t(e2.message);
        } finally {
          b.disabled = false;
        }
      },
    },
    h("div.brand.big", h("strong", "8star"), " Stream"),
    h("h1", t("Sign in")),
    field(t("Email address"), input("email", "", { type: "email", autocomplete: "username", required: true })),
    field(t("Password"), input("password", "", { type: "password", autocomplete: "current-password", required: true })),
    err,
    h("button.primary", { type: "submit" }, t("Sign in")),
    languageSwitch(),
  );
  add(root, h("div.login-wrap", form));
}

function languageSwitch() {
  return h(
    "div.lang-switch",
    [
      ["nl", "Nederlands"],
      ["en", "English"],
    ].map(([code, label]) =>
      h("button.link", { type: "button", "aria-pressed": String(App.lang === code), onclick: () => App.setLanguage(code) }, label),
    ),
  );
}

App.views.account = (main) => {
  const form = h(
    "form.card.narrow",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        if (d.next !== d.repeat) return toast(t("The new passwords do not match."), "error");
        act(form.querySelector("button"), async () => {
          await POST("/api/admin/me/password", { current: d.current, next: d.next });
          toast(t("Password changed. Please sign in again."));
          App.me = null;
          App.route();
        });
      },
    },
    h("h2", t("Change password")),
    field(t("Current password"), input("current", "", { type: "password", autocomplete: "current-password", required: true })),
    field(t("New password"), input("next", "", { type: "password", autocomplete: "new-password", minlength: 12, required: true }), t("At least 12 characters.")),
    field(t("Repeat new password"), input("repeat", "", { type: "password", autocomplete: "new-password", required: true })),
    h("button.primary", { type: "submit" }, t("Change password")),
  );
  add(main, 
    h("h1", t("Account")),
    h("div.card.narrow", h("h2", t("Interface language")), languageSwitch()),
    form,
    h("p.muted.small", "8star Stream " + App.meta.version + " · © 2026 Timo Manders"),
  );
};

window.addEventListener("hashchange", () => App.route());
document.addEventListener("DOMContentLoaded", () => App.route());
