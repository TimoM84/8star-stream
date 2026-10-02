#!/usr/bin/env node
"use strict";
// Checks the interface translations in public/i18n.js:
//  - admin: every text passed to t("…") in public/js/*.js, every error
//    message of the server and every provider field label has a Dutch
//    translation;
//  - watch page: every text passed to t("…") in public/watch.js and
//    public/form.js, and the server messages a viewer can see, have Dutch,
//    German and French translations;
//  - no unused entries.
// Exit code 1 when something is missing. Run: npm run check:i18n
// With --list it prints the missing keys only (handy when adding texts).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(read("public/i18n.js"), sandbox);
const I18N = sandbox.window.I18N;

const calls = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) out.add(JSON.parse('"' + m[1] + '"'));
  return out;
};
const failMessages = (src) => {
  const out = new Set();
  for (const m of src.matchAll(/fail\(\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"/g)) out.add(JSON.parse('"' + m[1] + '"'));
  return out;
};
const listDir = (d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".js")).map((f) => d + "/" + f);

// Admin texts.
const admin = new Set();
for (const f of listDir("public/js")) for (const k of calls(read(f))) admin.add(k);
const serverFiles = ["src/app.js", "src/auth.js", "src/http.js", "src/forms.js", "src/watch.js", ...listDir("src/api")];
for (const f of serverFiles) for (const k of failMessages(read(f))) admin.add(k);
for (const k of ["Please sign in.", "You do not have permission for this action.", "Too many sign-in attempts. Please try again later.", "Incorrect email address or password.", "Request too large.", "Invalid request.", "This request is not allowed.", "Not found.", "Method not allowed.", "Something went wrong. Please try again."]) admin.add(k);
const { catalog } = require(path.join(root, "src/providers"));
for (const p of catalog()) for (const f of p.fields) admin.add(f.label);
for (const k of ["No answer", "Stream ended", "No segments", "Not an HLS playlist", "Empty master playlist", "No playback URL", "Unreachable", "chat", "registration", "subtitles"]) admin.add(k);
const problemTexts = [
  "Styles that load content are not allowed.",
  "Images must come from the media library or an https address.",
  "The element <{0}> is not allowed.",
  "Event handlers such as {0} are not allowed.",
  "The link {0} is not allowed.",
  "Embedded content from {0} is not approved.",
];
for (const k of problemTexts) admin.add(k);

// Watch texts (viewer).
const watch = new Set([...calls(read("public/watch.js")), ...calls(read("public/form.js")), ...calls(read("public/player.js"))]);
for (const k of failMessages(read("src/watch.js"))) watch.add(k);
for (const m of read("src/forms.js").matchAll(/errors\[f\.id\]\s*=\s*(?:f\.type === "consent" \? "([^"]+)" : )?"([^"]+)"/g)) {
  if (m[1]) watch.add(m[1]);
  watch.add(m[2]);
}
for (const k of ["Something went wrong. Please try again.", "Invalid request.", "This request is not allowed.", "Please check the highlighted fields.", "No connection. Please try again.", "Registration", "Register"]) watch.add(k);

const problems = [];
const missing = { admin: [], watch: { nl: [], de: [], fr: [] } };
for (const k of admin) if (!I18N.admin.nl[k]) missing.admin.push(k);
for (const lang of ["nl", "de", "fr"]) for (const k of watch) if (!I18N.watch[lang][k]) missing.watch[lang].push(k);
if (process.argv.includes("--list")) {
  console.log(JSON.stringify(missing, null, 1));
  process.exit(0);
}
for (const k of missing.admin) problems.push("admin nl missing: " + k);
for (const lang of ["nl", "de", "fr"]) for (const k of missing.watch[lang]) problems.push("watch " + lang + " missing: " + k);
for (const k of Object.keys(I18N.admin.nl)) if (!admin.has(k)) problems.push("admin unused: " + k);
for (const lang of ["nl", "de", "fr"]) for (const k of Object.keys(I18N.watch[lang])) if (!watch.has(k)) problems.push("watch " + lang + " unused: " + k);
// Placeholders must survive translation.
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
for (const [k, v] of Object.entries(I18N.admin.nl)) if (ph(k) !== ph(v)) problems.push("admin placeholder mismatch: " + k);
for (const lang of ["nl", "de", "fr"]) for (const [k, v] of Object.entries(I18N.watch[lang])) if (ph(k) !== ph(v)) problems.push("watch " + lang + " placeholder mismatch: " + k);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error("\n" + problems.length + " problem(s).");
  process.exit(1);
}
console.log("Translations OK: " + admin.size + " admin texts (nl), " + watch.size + " watch texts (nl, de, fr).");
