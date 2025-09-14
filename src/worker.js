// Config via env vars (wrangler.toml [vars]):
// - PREFIX: route prefix for this worker (default "/"). Example: "/gh/"
// - WHITE_LIST: comma-separated substrings that must be present in target URL path
//               to allow proxying (default "HITSZ-OpenAuto"). Empty means allow all.
// - USE_JSDELIVR: "1" to rewrite blob/raw to jsDelivr when possible; "0" to proxy directly.

const DEFAULT_PREFIX = "/";
const DEFAULT_WHITE_LIST = "HITSZ-OpenAuto";
const DEFAULT_USE_JSDELIVR = false;

// Patterns
const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i;
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i;
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i;
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i;
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i;
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i;

/**
 * Normalize PREFIX to always start and end with '/'
 */
function normalizePrefix(p) {
  if (!p) return "/";
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s = s + "/";
  return s;
}

function parseWhiteList(str) {
  if (!str) return [];
  return String(str)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeRes(body, status = 200, headers = {}) {
  const h = new Headers(headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-expose-headers", "*");
  // Prevent indexing by search engines
  h.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
  return new Response(body, { status, headers: h });
}

function makeErrRes(msg, status = 400, headers = {}) {
  return makeRes(null, 302, { location: `/error?code=${status}&msg=${msg}` });
}

function newUrl(urlStr, base) {
  try {
    return base ? new URL(urlStr, base) : new URL(urlStr);
  } catch (err) {
    return null;
  }
}

function checkUrl(u) {
  for (const i of [exp1, exp2, exp3, exp4, exp5, exp6]) {
    if (u.search(i) === 0) return true;
  }
  return false;
}

function getPreflightHeaders() {
  const h = new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS",
    "access-control-max-age": "1728000",
  });
  h.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
  return h;
}

async function httpHandler(req, pathname, env) {
  // CORS preflight
  if (req.method === "OPTIONS" && req.headers.has("access-control-request-headers")) {
    return new Response(null, { status: 204, headers: getPreflightHeaders() });
  }

  // Whitelist check
  const whiteList = parseWhiteList(env.WHITE_LIST ?? DEFAULT_WHITE_LIST);
  let urlStr = pathname;
  let allowed = whiteList.length === 0; // empty whitelist => allow all
  for (const needle of whiteList) {
    if (needle && urlStr.includes(needle)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    return makeErrRes("blocked", 403);
  }

  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = "https://" + urlStr;
  }
  const urlObj = newUrl(urlStr);
  if (!urlObj) return makeErrRes("invalid target url", 400);

  const reqHdrNew = new Headers(req.headers);
  reqHdrNew.set("Accept-Language", "en");

  const reqInit = {
    method: req.method,
    headers: reqHdrNew,
    redirect: "manual",
    body: req.body,
  };
  return proxy(urlObj, reqInit, env);
}

async function proxy(urlObj, reqInit, env) {
  const res = await fetch(urlObj.href, reqInit);
  const resHdrNew = new Headers(res.headers);
  const status = res.status;

  // Handle redirects
  if (resHdrNew.has("location")) {
    const prefix = normalizePrefix(env.PREFIX ?? DEFAULT_PREFIX);
    let location = resHdrNew.get("location") || "";

    // If the redirect target is a GitHub/Gist/Raw URL we want to translate it back
    if (checkUrl(location)) {
      resHdrNew.set("location", prefix + location);
    } else {
      // Follow non-matching redirects directly
      reqInit.redirect = "follow";
      const nextUrl = newUrl(location, urlObj);
      if (nextUrl) return proxy(nextUrl, reqInit, env);
    }
  }

  // CORS + anti-indexing
  resHdrNew.set("access-control-expose-headers", "*");
  resHdrNew.set("access-control-allow-origin", "*");
  resHdrNew.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");

  // Remove security policies that can interfere with proxying
  resHdrNew.delete("content-security-policy");
  resHdrNew.delete("content-security-policy-report-only");
  resHdrNew.delete("clear-site-data");

  return new Response(res.body, { status, headers: resHdrNew });
}

export default {
  async fetch(request, env) {
    const prefix = normalizePrefix(env.PREFIX ?? DEFAULT_PREFIX);
    const u = new URL(request.url);

    // robots.txt: fully disallow crawling
    if (u.pathname === "/robots.txt") {
      return makeRes("User-agent: *\nDisallow: /\n", 200, {
        "content-type": "text/plain; charset=utf-8",
      });
    }

    // Serve static frontend from assets at root or at prefix root
    if (
      request.method === "GET" &&
      (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/error" || u.pathname === "/favicon.ico" ||
        u.pathname === prefix || u.pathname === prefix.slice(0, -1))
    ) {
      let assetRequest = request;
      // If visiting PREFIX root, rewrite to '/'
      if (u.pathname === prefix || u.pathname === prefix.slice(0, -1)) {
        const assetURL = new URL(request.url);
        assetURL.pathname = "/";
        assetRequest = new Request(assetURL.toString(), request);
      }
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        const assetRes = await env.ASSETS.fetch(assetRequest);
        let status = assetRes.status;
        const code = parseInt(u.searchParams.get('code'));
        console.log(code);
        if (code && code >= 400 && code < 600)
          status = code;
        const h = new Headers(assetRes.headers);
        h.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
        h.set("access-control-allow-origin", "*");
        h.set("access-control-expose-headers", "*");
        return new Response(assetRes.body, { status, headers: h });
      }
    }

    // Optional q param redirect support (kept from original)
    const q = u.searchParams.get("q");
    if (q) {
      const loc = `https://${u.host}${prefix}${q}`;
      return makeRes(null, 301, { location: loc });
    }

    // Cloudflare may collapse '//' to '/'. Rebuild target path from remainder
    let path = u.href
      .substring(u.origin.length + prefix.length)
      .replace(/^https?:\/+/i, "https://");

    // Route matching
    const useJsDelivr = String(env.USE_JSDELIVR ?? (DEFAULT_USE_JSDELIVR ? "1" : "0")) === "1";

    if (exp2.test(path)) {
      // github.com/.../(blob|raw)/...
      if (useJsDelivr) {
        // e.g., github.com/a/b/blob/x => cdn.jsdelivr.net/gh/a/b@x
        const newUrl = path
          .replace("/blob/", "@")
          .replace(/^(?:https?:\/\/)?github\.com/i, "https://cdn.jsdelivr.net/gh");
        return makeRes(null, 302, { location: newUrl });
      } else {
        path = path.replace("/blob/", "/raw/");
        return httpHandler(request, path, env);
      }
    }

    if (exp1.test(path) || exp3.test(path) || exp4.test(path) || exp5.test(path) || exp6.test(path)) {
      // Directly proxy these
      return httpHandler(request, path, env);
    } else {
      return makeErrRes("resource is not in whitelist", 403)
    }
  },
};

