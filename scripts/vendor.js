// Copies browser libraries from node_modules into public/vendor so the app
// serves them itself (no third-party CDN, strict Content-Security-Policy).
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const out = path.join(root, "public", "vendor");
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of [["node_modules/hls.js/dist/hls.min.js", "hls.min.js"]]) {
  const src = path.join(root, from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, to));
}
