"use strict";
// Minimal router: routes with :parameters, matched in the order they were
// added. Options per route: perm (permission needed), auth (false for
// public routes), raw (handler reads the body itself).
function createRouter() {
  const routes = [];
  const add = (method) => (path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(
      "^" +
        path.replace(/[.]/g, "\\.").replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, re, keys, handler, opts });
  };
  function match(method, pathname) {
    let allowed = false;
    for (const r of routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      if (r.method !== method) {
        allowed = true;
        continue;
      }
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        return null;
      }
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
  return { get: add("GET"), post: add("POST"), put: add("PUT"), patch: add("PATCH"), delete: add("DELETE"), match };
}

module.exports = { createRouter };
