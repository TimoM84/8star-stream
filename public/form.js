// Registration form rendering, shared by the watch page and the admin
// preview. Builds the fields with labels, help texts and error messages.
"use strict";
(function () {
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "checked" || k === "required" || k === "disabled") e[k] = Boolean(v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  // Plain text with line breaks → paragraphs (never HTML).
  const paragraphs = (text, cls) =>
    String(text || "")
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => {
        const node = el("p", { class: cls });
        p.split("\n").forEach((line, i) => {
          if (i) node.append(el("br"));
          node.append(line);
        });
        return node;
      });

  function render(form, { t = (s) => s, idPrefix = "rf", disabled = false } = {}) {
    const root = el("div", { class: "regform" });
    const inputs = new Map();
    const errorNodes = new Map();
    if (form.intro) root.append(...paragraphs(form.intro, "reg-intro"));
    for (const f of form.fields) {
      const id = idPrefix + "-" + f.id;
      const err = el("p", { class: "field-error", id: id + "-err", role: "alert", hidden: true });
      errorNodes.set(f.id, err);
      const help = f.help ? el("p", { class: "field-help", id: id + "-help", text: f.help }) : null;
      const described = [help && id + "-help", id + "-err"].filter(Boolean).join(" ");
      const required = f.required ? el("span", { class: "req", "aria-hidden": "true", text: " *" }) : null;
      let control;
      const common = { id, name: f.id, required: f.required, disabled, "aria-describedby": described, placeholder: f.placeholder || undefined };
      switch (f.type) {
        case "textarea":
          control = el("textarea", { ...common, rows: 4, maxlength: 5000 });
          break;
        case "select":
          control = el("select", common, el("option", { value: "", text: f.placeholder || t("Choose…") }), f.options.map((o) => el("option", { value: o.id, text: o.label })));
          break;
        case "radio":
        case "checkboxes": {
          const type = f.type === "radio" ? "radio" : "checkbox";
          control = el(
            "div",
            { class: "choices", role: type === "radio" ? "radiogroup" : "group", "aria-labelledby": id + "-label", "aria-describedby": described },
            f.options.map((o, i) =>
              el("label", { class: "choice" }, el("input", { type, name: f.id, value: o.id, id: id + "-" + i, disabled }), el("span", { text: o.label })),
            ),
          );
          break;
        }
        case "checkbox":
        case "consent":
          control = el("input", { ...common, type: "checkbox", placeholder: undefined });
          break;
        default:
          control = el("input", {
            ...common,
            type: { email: "email", phone: "tel", number: "number", date: "date" }[f.type] || "text",
            autocomplete: { email: "email", phone: "tel" }[f.type],
            inputmode: f.type === "number" ? "decimal" : undefined,
            maxlength: f.type === "text" ? 500 : undefined,
          });
      }
      inputs.set(f.id, { f, control });
      let wrap;
      if (f.type === "checkbox" || f.type === "consent") {
        const text = f.type === "consent" ? paragraphs(f.label, "consent-text") : [el("span", { text: f.label })];
        // The required mark goes at the end of the (last paragraph of the) text.
        if (required) text[text.length - 1]?.append(required);
        wrap = el("div", { class: "rf-field rf-check" }, el("label", { for: id, id: id + "-label" }, control, el("span", {}, ...text)), help, err);
      } else if (f.type === "radio" || f.type === "checkboxes") {
        wrap = el("fieldset", { class: "rf-field" }, el("legend", { id: id + "-label" }, f.label, required), help, control, err);
      } else {
        wrap = el("div", { class: "rf-field" }, el("label", { for: id, id: id + "-label" }, f.label, required), control, help, err);
      }
      root.append(wrap);
    }
    if (form.privacy) root.append(el("div", { class: "reg-privacy" }, ...paragraphs(form.privacy)));
    // Honeypot for automated submissions (hidden from people and screen readers).
    root.append(el("div", { class: "hp", "aria-hidden": "true" }, el("label", { text: "Website" }, el("input", { name: "website", tabindex: "-1", autocomplete: "off" }))));

    function values() {
      const out = {};
      for (const [fid, { f, control }] of inputs) {
        if (f.type === "radio") out[fid] = control.querySelector("input:checked")?.value || "";
        else if (f.type === "checkboxes") out[fid] = [...control.querySelectorAll("input:checked")].map((x) => x.value);
        else if (f.type === "checkbox" || f.type === "consent") out[fid] = control.checked;
        else out[fid] = control.value;
      }
      return out;
    }
    function showErrors(errors = {}) {
      let first = null;
      for (const [fid, node] of errorNodes) {
        const msg = errors[fid];
        node.hidden = !msg;
        node.textContent = msg ? t(msg) : "";
        const c = inputs.get(fid).control;
        if (msg) {
          c.setAttribute("aria-invalid", "true");
          first ||= c.matches("div") ? c.querySelector("input") : c;
        } else c.removeAttribute("aria-invalid");
      }
      first?.focus();
    }
    const honeypot = () => root.querySelector(".hp input").value;
    return { el: root, values, showErrors, honeypot };
  }
  window.RegForm = { render, paragraphs };
})();
