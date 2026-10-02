// Admin core: DOM helper, API calls, translations, dialogs, small widgets.
// Everything user-provided is inserted as text (never as HTML), except the
// page editor, whose HTML is checked by the server and covered by the CSP.
"use strict";

const App = (window.App = {
  me: null,
  meta: null,
  csrf: "",
  lang: "nl",
  views: {},
  timers: [],
});

// ---- Translation -----------------------------------------------------------
(() => {
  let stored = "";
  try {
    stored = localStorage.getItem("8star-stream-language") || "";
  } catch {}
  App.lang = ["en", "nl"].includes(stored) ? stored : /^nl\b/i.test(navigator.language || "") ? "nl" : "en";
})();
function t(s, vars) {
  let out = (App.lang !== "en" && window.I18N?.admin?.[App.lang]?.[s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return out;
}
App.setLanguage = (lang) => {
  App.lang = lang;
  try {
    localStorage.setItem("8star-stream-language", lang);
  } catch {}
  document.documentElement.lang = lang;
  App.route();
};

// ---- DOM ------------------------------------------------------------------
// h("div.card#main", { onclick, title, ... }, child, "text", [children])
function h(spec, attrs, ...children) {
  if (attrs === null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [, tag = "div", rest = ""] = spec.match(/^([a-z0-9]*)(.*)$/i);
  const el = document.createElement(tag || "div");
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "selected" || k === "disabled" || k === "multiple") el[k] = Boolean(v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  const put = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(put);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(put);
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};
// Appends children like h() does: arrays are flattened, empty values skipped.
function add(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const fill = (el, ...children) => add(clear(el), ...children);

// ---- API ------------------------------------------------------------------
async function api(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (App.csrf) headers["x-csrf-token"] = App.csrf;
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.allow401) {
    App.me = null;
    App.route();
  }
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong. Please try again.");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const GET = (u) => api("GET", u);
const POST = (u, b = {}) => api("POST", u, b);
const PUT = (u, b = {}) => api("PUT", u, b);
const PATCH = (u, b = {}) => api("PATCH", u, b);
const DELETE = (u) => api("DELETE", u);
const qs = (o) =>
  "?" +
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
const can = (p) => Boolean(App.me?.permissions?.includes(p));

// ---- Formatting -----------------------------------------------------------
const locale = () => (App.lang === "nl" ? "nl-NL" : "en-GB");
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(locale(), { dateStyle: "medium" }) : "—");
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale(), { timeStyle: "short" }) : "");
const fmtNumber = (n, d = 0) => Number(n || 0).toLocaleString(locale(), { maximumFractionDigits: d, minimumFractionDigits: d });
// <input type="datetime-local"> value from ISO, and back.
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const hms = (s) => {
  if (s === null || s === undefined || s === "") return "";
  s = Math.max(0, Math.round(Number(s)));
  const hh = Math.floor(s / 3600),
    mm = Math.floor((s % 3600) / 60),
    ss = s % 60;
  return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
};
const PHASE_LABEL = () => ({ pre: t("Before"), live: t("Live"), after: t("After live"), vod: t("VOD") });
const STATUS_LABEL = () => ({ draft: t("Draft"), test: t("Test"), scheduled: t("Scheduled"), archived: t("Archived") });
const ROLE_LABEL = () => ({ admin: t("Administrator"), technician: t("Technician"), content: t("Content manager") });
const pill = (text, kind = "") => h("span.pill" + (kind ? "." + kind : ""), text);
const statusPill = (s) => pill(STATUS_LABEL()[s] || s, s);
const phasePill = (p) => pill(PHASE_LABEL()[p] || p, "phase-" + p);
const signalPill = (route) =>
  !route
    ? pill(t("Not set"), "muted")
    : route.signal === "ok"
      ? pill(t("Signal"), "ok")
      : route.signal === "lost"
        ? pill(t("No signal"), "bad")
        : pill(t("Unknown"), "muted");

// ---- Feedback --------------------------------------------------------------
function toast(message, kind = "ok") {
  let box = $("#toasts");
  if (!box) document.body.append((box = h("div#toasts", { role: "status", "aria-live": "polite" })));
  const el = h("div.toast." + kind, message);
  box.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}
const showError = (e) => toast(t(e.message || String(e)), "error");
// Runs an async action from a button, with busy state and error toast.
async function act(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    if (e.data?.problems) problemsDialog(e.data.problems);
    else showError(e);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// ---- Dialogs ---------------------------------------------------------------
function dialog(title, body, actions = [], opts = {}) {
  const d = h("dialog.dialog" + (opts.wide ? ".wide" : ""), { "aria-label": title });
  const close = () => {
    d.close();
    d.remove();
  };
  const form = h(
    "form",
    {
      method: "dialog",
      onsubmit: (e) => {
        e.preventDefault();
        actions.find((a) => a.primary)?.run?.(close, form);
      },
    },
    h("header", h("h2", title), h("button.icon", { type: "button", "aria-label": t("Close"), onclick: close }, "×")),
    h("div.dialog-body", body),
    h(
      "footer",
      h("button.secondary", { type: "button", onclick: close }, opts.cancel || t("Cancel")),
      actions.map((a) =>
        h(
          "button" + (a.danger ? ".danger" : a.primary ? ".primary" : ".secondary"),
          {
            type: a.primary ? "submit" : "button",
            onclick: a.primary ? undefined : (e) => a.run(close, form, e.currentTarget),
          },
          a.label,
        ),
      ),
    ),
  );
  d.append(form);
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(d);
  d.showModal();
  d.querySelector("input:not([type=hidden]),select,textarea")?.focus();
  return { close, form, dialog: d };
}
function confirmDialog(title, text, label, danger = false) {
  return new Promise((resolve) => {
    const d = dialog(title, h("p", text), [
      {
        label,
        primary: true,
        danger,
        run: (close) => {
          close();
          resolve(true);
        },
      },
    ]);
    d.dialog.addEventListener("close", () => resolve(false));
  });
}
function problemsDialog(problems) {
  dialog(t("This content cannot be saved."), [
    h("p", t("Remove or change the following and try again:")),
    h(
      "ul.problems",
      problems.map((p) => h("li", translateProblem(p))),
    ),
  ]);
}
// Problems from the HTML check have variable parts (element, host).
function translateProblem(p) {
  const rules = [
    [/^The element <(.+)> is not allowed\.$/, "The element <{0}> is not allowed."],
    [/^Event handlers such as (.+) are not allowed\.$/, "Event handlers such as {0} are not allowed."],
    [/^The link (.+) is not allowed\.$/, "The link {0} is not allowed."],
    [/^Embedded content from (.+) is not approved\.$/, "Embedded content from {0} is not approved."],
  ];
  for (const [re, key] of rules) {
    const m = p.match(re);
    if (m) return t(key).replace("{0}", m[1]);
  }
  return t(p);
}

// ---- Form fields -------------------------------------------------------------
let fieldSeq = 0;
function field(label, input, help) {
  const fid = input.id || "f" + ++fieldSeq;
  input.id = fid;
  return h("div.field", h("label", { for: fid }, label), input, help ? h("small.help", help) : null);
}
const input = (name, value = "", attrs = {}) => h("input", { name, value: value ?? "", ...attrs });
const textarea = (name, value = "", attrs = {}) => {
  const el = h("textarea", { name, rows: 4, ...attrs });
  el.value = value ?? "";
  return el;
};
const select = (name, options, value, attrs = {}) =>
  h(
    "select",
    { name, ...attrs },
    options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value ?? "") }, label)),
  );
const checkbox = (name, label, checked, attrs = {}) =>
  h("label.check", h("input", { type: "checkbox", name, checked, ...attrs }), h("span", label));
const formData = (form) => {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
};
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("Copied."));
  } catch {
    toast(t("Copy failed. Select the text and copy it yourself."), "error");
  }
}
function download(url) {
  const a = h("a", { href: url, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}
// Table: columns [{ label, value(row) → node|text, class }]
function table(columns, rows, opts = {}) {
  if (!rows.length) return h("p.empty", opts.empty || t("Nothing here yet."));
  return h(
    "div.table-wrap",
    h(
      "table",
      h("thead", h("tr", columns.map((c) => h("th", { class: c.class }, c.label)))),
      h(
        "tbody",
        rows.map((r) =>
          h(
            "tr",
            { class: opts.rowClass?.(r), onclick: opts.onRow ? () => opts.onRow(r) : undefined, tabindex: opts.onRow ? 0 : undefined, onkeydown: opts.onRow ? (e) => e.key === "Enter" && opts.onRow(r) : undefined },
            columns.map((c) => h("td", { class: c.class, "data-label": c.label }, c.value(r))),
          ),
        ),
      ),
    ),
  );
}
// Media picker: resolves with a media URL or null.
function pickMedia() {
  return new Promise(async (resolve) => {
    let chosen = null;
    const grid = h("div.media-grid", h("p.muted", t("Loading…")));
    const upload = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" });
    const d = dialog(
      t("Choose an image"),
      [h("div.toolbar", h("label.button.secondary", t("Upload image"), upload)), grid],
      [],
      { wide: true },
    );
    d.dialog.addEventListener("close", () => resolve(chosen));
    const loadItems = async () => {
      const items = await GET("/api/admin/media").catch(() => []);
      clear(grid);
      if (!items.length) grid.append(h("p.empty", t("No images yet. Upload one.")));
      for (const m of items)
        grid.append(
          h(
            "button.media-item",
            {
              type: "button",
              onclick: () => {
                chosen = m.url;
                d.close();
                resolve(m.url);
              },
            },
            h("img", { src: m.url, alt: "", loading: "lazy" }),
            h("span", m.name),
          ),
        );
    };
    upload.addEventListener("change", async () => {
      const f = upload.files[0];
      if (!f) return;
      await act(null, async () => {
        await uploadMedia(f);
        await loadItems();
      });
    });
    loadItems();
  });
}
async function uploadMedia(file) {
  const res = await fetch("/api/admin/media", {
    method: "POST",
    headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name), "x-csrf-token": App.csrf },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Upload failed."), { data });
  return data;
}
// Plays an HLS or MP4 address in a <video> (hls.js where needed).
function attachVideo(video, url, { onError } = {}) {
  if (video._hls) {
    video._hls.destroy();
    video._hls = null;
  }
  if (!url) {
    video.removeAttribute("src");
    video.load();
    return;
  }
  const isHls = /\.m3u8(\?|$)/i.test(url);
  if (isHls && window.Hls?.isSupported()) {
    const hls = new window.Hls({ liveSyncDurationCount: 3, enableWorker: true });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        onError?.(data);
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls.startLoad(), 3000);
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    video._hls = hls;
  } else video.src = url;
}
// Repeating timers of the current view are stopped when the view changes.
function every(ms, fn) {
  const id = setInterval(fn, ms);
  App.timers.push(id);
  return id;
}
