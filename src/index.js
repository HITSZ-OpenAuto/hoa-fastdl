import 'urlpattern-polyfill';

// Config via env vars (wrangler.toml [vars]):
// - PREFIX: route prefix for this worker. Example: "/gh/"
// - WHITE_LIST: comma-separated substrings that must be present in target URL path
//               to allow proxying. Empty means allow all.
// - USE_JSDELIVR: "1" to rewrite blob/raw to jsDelivr when possible; "0" to proxy directly.
// - ALLOWED_ORIGINS: comma-separated list of allowed origins for CORS.

// URLPattern definitions for GitHub resources
const blobRawPatterns = [
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/blob/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/raw/*' }),
];

const directProxyPatterns = [
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/releases/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/archive/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/info*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/git-*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'raw.githubusercontent.com', pathname: '/*/*/*/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'raw.github.com', pathname: '/*/*/*/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'gist.githubusercontent.com', pathname: '/*/*/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'gist.github.com', pathname: '/*/*/*' }),
  new URLPattern({ protocol: 'http{s}?', hostname: 'github.com', pathname: '/*/*\/tags*' }),
];

/**
 * Check if a path/URL represents a blob or raw file resource
 */
function isBlobRawUrl(u) {
  if (!u) return false;
  let target = String(u).trim();
  if (!/^https?:\/\//i.test(target)) {
    target = 'https://' + target;
  }
  return blobRawPatterns.some((p) => p.test(target));
}

/**
 * Check if a URL matches any supported GitHub resource pattern
 */
function checkUrl(u) {
  if (!u) return false;
  let target = String(u).trim();
  if (!/^https?:\/\//i.test(target)) {
    target = 'https://' + target;
  }
  return (
    isBlobRawUrl(target) ||
    directProxyPatterns.some((p) => p.test(target))
  );
}

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

/**
 * Check if origin is allowed
 */
function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",");
    for (const allowed of allowedOrigins) {
      const s = allowed.trim();
      if (!s) continue;
      // Match exactly or any subdomain
      if (hostname === s || hostname.endsWith('.' + s)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function makeRes(body, status = 200, headers = {}) {
  const h = new Headers(headers);
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

function getPreflightHeaders() {
  return new Headers({
    "access-control-allow-methods": "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS",
    "access-control-max-age": "1728000",
  });
}

async function httpHandler(req, pathname, env) {
  // CORS preflight
  if (req.method === "OPTIONS" && req.headers.has("access-control-request-headers")) {
    const preflightHeaders = getPreflightHeaders();
    preflightHeaders.set("access-control-allow-headers", req.headers.get("access-control-request-headers"));
    return new Response(null, { status: 204, headers: preflightHeaders });
  }

  // Whitelist check
  const whiteList = parseWhiteList(env.WHITE_LIST);
  let urlStr = pathname;
  let allowed = whiteList.length === 0; // empty whitelist => allow all
  for (const needle of whiteList) {
    if (needle && urlStr.includes(needle)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    return makeErrRes("owner is not allowed", 403);
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
  
  // Reject 4XX 5XX
  if (status >= 400)
    return makeErrRes("failed to access resource", status);

  // Handle redirects
  if (resHdrNew.has("location")) {
    const prefix = normalizePrefix(env.PREFIX);
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

  // Remove security policies that can interfere with proxying
  resHdrNew.delete("content-security-policy");
  resHdrNew.delete("content-security-policy-report-only");
  resHdrNew.delete("clear-site-data");

  return new Response(res.body, { status, headers: resHdrNew });
}

async function handleRequest(request, env) {
  const prefix = normalizePrefix(env.PREFIX);
  const u = new URL(request.url);

  // Serve static frontend from assets at root or at prefix root
  if (
    request.method === "GET" &&
    (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/error" || u.pathname === "/favicon.ico" ||
      u.pathname === "/robots.txt" || u.pathname === prefix || u.pathname === prefix.slice(0, -1))
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
      if (code && code >= 400 && code < 600)
        status = code;
      const h = new Headers(assetRes.headers);
      return new Response(assetRes.body, { status, headers: h });
    }
  }

  // Optional q param redirect support
  const q = u.searchParams.get("q");
  if (q) {
    const loc = `https://${u.host}${prefix}${q}`;
    return makeRes(null, 301, { location: loc });
  }

  // Block search engine crawlers to trigger de-indexing
  const ua = request.headers.get("User-Agent") || "";
  if (ua.toLowerCase().includes("bingbot") || ua.toLowerCase().includes("duckduckbot")) {
    return makeRes("Gone", 410);
  }

  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const refHostname = new URL(referer).hostname;
      if (refHostname.includes("bing.com") || refHostname.includes("duckduckgo.com")) {
        return makeErrRes("referer not allowed", 403);
      }
    } catch (e) {
      // ignore invalid referer
    }
  }

  // Cloudflare may collapse '//' to '/'. Rebuild target path from remainder
  let path = u.href
    .substring(u.origin.length + prefix.length)
    .replace(/^https?:\/+/i, "https://");

  // Route matching
  const useJsDelivr = String(env.USE_JSDELIVR) === "1";

  if (isBlobRawUrl(path)) {
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

  if (checkUrl(path)) {
    // Directly proxy these
    return httpHandler(request, path, env);
  } else {
    return makeErrRes("resource is not in whitelist", 403);
  }
}

export default {
  async fetch(request, env) {
    const response = await handleRequest(request, env);
    const newHeaders = new Headers(response.headers);
    const origin = request.headers.get("origin");

    // CORS + anti-indexing
    if (isAllowedOrigin(origin, env)) {
      newHeaders.set("access-control-allow-origin", origin);
      newHeaders.set("access-control-expose-headers", "*");
    }
    newHeaders.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
