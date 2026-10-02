"use strict";
// Registration forms: field definitions (checked when the form is saved)
// and answers (checked when a visitor registers). Every registration keeps a
// copy of the fields it was made with, so it stays readable when the form
// changes later.
const { fail } = require("./http");
const { cleanLine, clean, isEmail, id: newId } = require("./util");

const TYPES = ["text", "textarea", "email", "phone", "number", "date", "checkbox", "radio", "checkboxes", "select", "consent"];
const WITH_OPTIONS = ["radio", "checkboxes", "select"];
const LANGUAGE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

function fieldsIn(list) {
  if (!Array.isArray(list)) fail(400, "Invalid request.");
  if (list.length > 60) fail(400, "A form can have at most 60 fields.");
  const ids = new Set();
  return list.map((f) => {
    const type = TYPES.includes(f?.type) ? f.type : fail(400, "Choose a field type.");
    let fid = /^[a-z0-9]{4,24}$/.test(String(f.id || "")) ? f.id : newId(10);
    if (ids.has(fid)) fid = newId(10);
    ids.add(fid);
    const label = clean(f.label, type === "consent" ? 2000 : 300);
    if (!label) fail(400, "Every field needs a name or question.");
    const out = {
      id: fid,
      type,
      label,
      help: clean(f.help, 500),
      placeholder: cleanLine(f.placeholder, 120),
      required: Boolean(f.required),
      active: f.active !== false,
    };
    const optionIds = new Set();
    if (WITH_OPTIONS.includes(type)) {
      out.options = (Array.isArray(f.options) ? f.options : [])
        .slice(0, 100)
        .map((o) => {
          let oid = /^[a-z0-9]{4,24}$/.test(String(o?.id || "")) ? o.id : newId(8);
          if (optionIds.has(oid)) oid = newId(8);
          optionIds.add(oid);
          return { id: oid, label: cleanLine(o?.label, 200) };
        })
        .filter((o) => o.label);
      if (!out.options.length) fail(400, "Every multiple-choice question and dropdown needs at least one answer option.");
    }
    // Texts in other languages: label, help, placeholder, option labels.
    out.translations = {};
    for (const [code, tr] of Object.entries(f.translations && typeof f.translations === "object" ? f.translations : {})) {
      if (!LANGUAGE_CODE.test(code) || !tr || typeof tr !== "object") continue;
      const t = {
        label: clean(tr.label, type === "consent" ? 2000 : 300),
        help: clean(tr.help, 500),
        placeholder: cleanLine(tr.placeholder, 120),
      };
      if (out.options) {
        t.options = {};
        for (const o of out.options) if (tr.options?.[o.id]) t.options[o.id] = cleanLine(tr.options[o.id], 200);
      }
      out.translations[code] = t;
    }
    return out;
  });
}

function textsIn(texts) {
  const out = {};
  for (const [code, t] of Object.entries(texts && typeof texts === "object" ? texts : {})) {
    if (!LANGUAGE_CODE.test(code) || !t || typeof t !== "object") continue;
    out[code] = {
      intro: clean(t.intro, 4000),
      privacy: clean(t.privacy, 4000),
      confirmation: clean(t.confirmation, 4000),
      pending: clean(t.pending, 2000),
      submit: cleanLine(t.submit, 60),
    };
  }
  return out;
}

// A field as the visitor sees it, in their language (default language as
// fallback for missing translations).
function localField(f, code) {
  const tr = f.translations?.[code] || {};
  return {
    id: f.id,
    type: f.type,
    label: tr.label || f.label,
    help: tr.help || f.help,
    placeholder: tr.placeholder || f.placeholder,
    required: f.required,
    options: f.options?.map((o) => ({ id: o.id, label: tr.options?.[o.id] || o.label })),
  };
}

// Checks answers against the active fields. Returns clean answers, the
// first email address, consent records, and errors per field.
function answersIn(fields, raw, code, at) {
  const answers = {},
    errors = {},
    consent = [];
  let email = "";
  const input = raw && typeof raw === "object" ? raw : {};
  for (const f of fields.filter((x) => x.active)) {
    const v = input[f.id];
    const local = localField(f, code);
    const empty = v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) errors[f.id] = f.type === "consent" ? "Please give your consent." : "This field is required.";
      continue;
    }
    switch (f.type) {
      case "text":
      case "textarea": {
        const s = f.type === "text" ? cleanLine(v, 500) : clean(v, 5000);
        if (s) answers[f.id] = s;
        else if (f.required) errors[f.id] = "This field is required.";
        break;
      }
      case "email": {
        const s = cleanLine(v, 200).toLowerCase();
        if (!isEmail(s)) errors[f.id] = "Enter a valid email address.";
        else {
          answers[f.id] = s;
          email ||= s;
        }
        break;
      }
      case "phone": {
        const s = cleanLine(v, 40);
        if (!/^\+?[0-9 ()./-]{6,30}$/.test(s)) errors[f.id] = "Enter a valid phone number.";
        else answers[f.id] = s;
        break;
      }
      case "number": {
        const n = Number(String(v).replace(",", "."));
        if (!Number.isFinite(n)) errors[f.id] = "Enter a number.";
        else answers[f.id] = n;
        break;
      }
      case "date": {
        const s = String(v);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) errors[f.id] = "Enter a valid date.";
        else answers[f.id] = s;
        break;
      }
      case "checkbox":
        answers[f.id] = v === true;
        break;
      case "consent":
        if (v !== true) {
          if (f.required) errors[f.id] = "Please give your consent.";
        } else {
          answers[f.id] = true;
          // The exact text the visitor agreed to, and when.
          consent.push({ field: f.id, text: local.label, language: code, at });
        }
        break;
      case "radio":
      case "select":
        if (!f.options.some((o) => o.id === v)) errors[f.id] = "Choose one of the options.";
        else answers[f.id] = v;
        break;
      case "checkboxes": {
        const list = (Array.isArray(v) ? v : [v]).filter((x) => f.options.some((o) => o.id === x));
        if (!list.length) errors[f.id] = "Choose one of the options.";
        else answers[f.id] = [...new Set(list)];
        break;
      }
    }
  }
  return { answers, errors, email, consent };
}

// Readable value of an answer, using the field copy stored with the
// registration (default-language labels).
function display(field, value) {
  if (value === undefined || value === null) return "";
  if (field?.type === "checkbox" || field?.type === "consent") return value ? "Yes" : "No";
  const label = (oid) => field?.options?.find((o) => o.id === oid)?.label || oid;
  if (Array.isArray(value)) return value.map(label).join("; ");
  if (field?.options) return label(value);
  return String(value);
}

module.exports = { TYPES, fieldsIn, textsIn, localField, answersIn, display };
