"use strict";
// Watch page HTML: checked before it is saved or published.
//
// check(html, allowedIframeHosts) lists every problem in plain language
// (scripts, event handlers, javascript: links, forms, unknown tags, iframes
// from sources that are not approved). Content with problems is refused, so
// nothing is silently changed. clean(html) then normalises the accepted
// HTML with an allow-list, as a second line of defence.
const { Parser } = require("htmlparser2");
const sanitizeHtml = require("sanitize-html");

const TAGS = [
  "h1", "h2", "h3", "h4", "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "small", "sub", "sup",
  "ul", "ol", "li", "a", "img", "figure", "figcaption", "blockquote", "span", "div",
  "table", "thead", "tbody", "tr", "th", "td", "iframe",
];
const ATTRS = {
  "*": ["class", "style", "title", "lang", "dir"],
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height", "loading"],
  iframe: ["src", "width", "height", "allow", "allowfullscreen", "title", "loading"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan", "scope"],
};
// Inline styles are limited to presentation that cannot load anything.
const STYLES = {
  "text-align": [/^(left|right|center|justify)$/],
  color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
  "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
  width: [/^\d{1,4}(px|%)$/],
  "max-width": [/^\d{1,4}(px|%)$/],
  float: [/^(left|right|none)$/],
  margin: [/^[\d\s.]+(px|em|rem)?(\s+[\d.]+(px|em|rem)?){0,3}$/],
  "font-weight": [/^(normal|bold|[1-9]00)$/],
  "font-style": [/^(normal|italic)$/],
  "text-decoration": [/^(none|underline|line-through)$/],
};
const URL_SCHEMES = ["https", "http", "mailto", "tel"];

const hostOf = (src) => {
  try {
    const u = new URL(src);
    return u.protocol === "https:" ? u.host.toLowerCase() : "";
  } catch {
    return "";
  }
};
const iframeAllowed = (src, hosts) => {
  const h = hostOf(src);
  return Boolean(h) && hosts.some((a) => h === a || h.endsWith("." + a));
};
const badUrl = (v) => {
  const s = String(v || "").replace(/[\u0000- ]/g, "").toLowerCase();
  if (!s) return false;
  if (s.startsWith("#") || s.startsWith("/")) return false;
  const m = s.match(/^([a-z][a-z0-9+.-]*):/);
  return m ? !URL_SCHEMES.includes(m[1]) : false;
};

function check(html, allowedIframeHosts = []) {
  const problems = new Set();
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (!TAGS.includes(name)) problems.add("The element <" + name + "> is not allowed.");
        for (const [k, v] of Object.entries(attrs)) {
          if (/^on/i.test(k)) problems.add("Event handlers such as " + k + " are not allowed.");
          if (["href", "src"].includes(k) && badUrl(v)) problems.add("The link " + String(v).slice(0, 60) + " is not allowed.");
          if (k === "style" && /url\s*\(|expression\s*\(|@import/i.test(v)) problems.add("Styles that load content are not allowed.");
        }
        if (name === "iframe" && !iframeAllowed(attrs.src, allowedIframeHosts))
          problems.add("Embedded content from " + (hostOf(attrs.src) || "this source") + " is not approved.");
        if (name === "img" && attrs.src && !/^(https?:)?\/\//i.test(attrs.src) && !attrs.src.startsWith("/media/"))
          problems.add("Images must come from the media library or an https address.");
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(String(html || ""));
  parser.end();
  return [...problems];
}

function clean(html, allowedIframeHosts = []) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: TAGS,
    allowedAttributes: ATTRS,
    allowedStyles: { "*": STYLES },
    allowedSchemes: URL_SCHEMES,
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    allowedIframeDomains: allowedIframeHosts,
    allowIframeRelativeUrls: false,
    transformTags: {
      // Links that open a new window never get access to this page.
      a: (tagName, attribs) =>
        attribs.target === "_blank" ? { tagName, attribs: { ...attribs, rel: "noopener noreferrer" } } : { tagName, attribs },
    },
    exclusiveFilter: (frame) => frame.tag === "iframe" && !iframeAllowed(frame.attribs.src, allowedIframeHosts),
  });
}

module.exports = { check, clean };
