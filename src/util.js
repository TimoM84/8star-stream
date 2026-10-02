"use strict";
// Small shared helpers: ids, hashing, time, text clean-up.
const crypto = require("node:crypto");

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
// Random id from an unambiguous alphabet (no 0/o, 1/l).
function id(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}
const token = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const now = () => new Date().toISOString();

// Passwords and access codes: salted scrypt, verified in constant time.
function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(secret), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve("scrypt$" + salt.toString("base64") + "$" + key.toString("base64")),
    ),
  );
}
function verifySecret(secret, stored) {
  return new Promise((resolve) => {
    const [kind, salt, hash] = String(stored || "").split("$");
    if (kind !== "scrypt" || !salt || !hash) return resolve(false);
    const expected = Buffer.from(hash, "base64");
    crypto.scrypt(String(secret), Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 }, (err, key) =>
      resolve(!err && key.length === expected.length && crypto.timingSafeEqual(key, expected)),
    );
  });
}

// Plain text from user input: no control characters, trimmed, bounded.
const clean = (s, max = 500) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
const cleanLine = (s, max = 200) => clean(s, max).replace(/[\r\n\t]+/g, " ");
const isEmail = (s) => /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(String(s || ""));
const isHttpUrl = (s) => {
  try {
    const u = new URL(String(s));
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};
const json = (s, fallback) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};
const slugify = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

module.exports = { id, token, sha256, now, hashSecret, verifySecret, clean, cleanLine, isEmail, isHttpUrl, json, slugify };
