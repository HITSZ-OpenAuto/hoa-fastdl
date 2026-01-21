// Config via env vars (wrangler.toml [vars]):
// - PREFIX: route prefix for this worker. Example: "/gh/"
// - WHITE_LIST: comma-separated substrings that must be present in target URL path to allow proxying.
// - USE_JSDELIVR: "1" to rewrite blob/raw to jsDelivr when possible.
// - ALLOWED_ORIGINS: comma-separated list of allowed origins for CORS.

// URL patterns for GitHub resources
const PATTERNS = [
  new URLPattern({ hostname: 'github.com', pathname: '/:owner/:repo/{releases,archive}/*' }),
  new URLPattern({ hostname: 'github.com', pathname: '/:owner/:repo/{blob,raw}/*' }),
  new URLPattern({ hostname: 'github.com', pathname: '/:owner/:repo/{info,git-}*' }),
  new URLPattern({ hostname: 'raw.githubusercontent.com', pathname: '/:owner/:repo/:branch/:path*' }),
  new URLPattern({ hostname: 'raw.github.com', pathname: '/:owner/:repo/:branch/:path*' }),
  new URLPattern({ hostname: 'gist.github.com', pathname: '/:user/:id*' }),
  new URLPattern({ hostname: 'gist.githubusercontent.com', pathname: '/:user/:id*' }),
  new URLPattern({ hostname: 'github.com', pathname: '/:owner/:repo/tags*' }),
];

// Helper to check if a URL matches any GitHub pattern
function isGitHubUrl(url) {
  try {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    return PATTERNS.some(p => p.test(urlObj));
  } catch {
    return false;
  }
}

function normalizePrefix(p) {
  if (!p) return "/";
  let s = p.trim();
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s = s + "/";
  return s;
}

function parseWhiteList(str) {
  return (str || "").split(",").map(s => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const allowed = parseWhiteList(env.ALLOWED_ORIGINS);
    return allowed.some(s => url.hostname === s || url.hostname.endsWith('.' + s));
  } catch {
    return false;
  }
}

async function proxy(url, request, env) {
  const targetUrl = new URL(url);
  const reqInit = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "manual",
    body: request.body,
  };
  
  // Set some sensible defaults for proxying
  reqInit.headers.set("Accept-Language", "en");
  // Ensure we don't pass through the original Host header
  reqInit.headers.delete("host");

  const res = await fetch(targetUrl.href, reqInit);
  const status = res.status;

  // Reject 4XX/5XX with a redirect to our error page
  if (status >= 400) {
    return Response.redirect(`${new URL(request.url).origin}${normalizePrefix(env.PREFIX)}error?code=${status}&msg=failed to access resource`, 302);
  }

  const resHdrNew = new Headers(res.headers);
  
  // Handle redirects: translate GitHub locations back through the proxy
  if (resHdrNew.has("location")) {
    const loc = resHdrNew.get("location");
    if (isGitHubUrl(loc)) {
      const prefix = normalizePrefix(env.PREFIX);
      resHdrNew.set("location", `${new URL(request.url).origin}${prefix}${loc}`);
    } else {
      // Follow other redirects
      return proxy(loc, request, env);
    }
  }

  // Security cleanup
  ["content-security-policy", "content-security-policy-report-only", "clear-site-data"].forEach(h => resHdrNew.delete(h));

  return new Response(res.body, { status, headers: resHdrNew });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const prefix = normalizePrefix(env.PREFIX);
    
    // 1. Static Assets & Frontend Routing
    const isRoot = url.pathname === "/" || url.pathname === prefix || url.pathname === prefix.slice(0, -1);
    const isStatic = ["/index.html", "/error", "/favicon.ico", "/robots.txt"].includes(url.pathname);
    
    if (request.method === "GET" && (isRoot || isStatic)) {
      if (env.ASSETS) {
        let assetPath = url.pathname;
        if (isRoot) assetPath = "/index.html";
        
        const assetRes = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
        if (assetRes.ok || assetRes.status < 400) {
          const code = parseInt(url.searchParams.get('code'));
          const status = (code >= 400 && code < 600) ? code : assetRes.status;
          return new Response(assetRes.body, { status, headers: assetRes.headers });
        }
      }
    }

    // 2. Bot Protection (using request.cf)
    const ua = request.headers.get("User-Agent") || "";
    const isBot = /bingbot|duckduckbot|googlebot|baiduspider/i.test(ua) || 
                  (request.cf?.asOrganization && /bing|duckduckgo|baidu/i.test(request.cf.asOrganization));
    
    if (isBot) {
      return new Response("Gone", { status: 410 });
    }

    // 3. Referer Block
    const referer = request.headers.get("Referer");
    if (referer) {
      try {
        const refHost = new URL(referer).hostname;
        if (/bing\.com|duckduckgo\.com|baidu\.com/i.test(refHost)) {
          return Response.redirect(`${url.origin}${prefix}error?code=403&msg=referer not allowed`, 302);
        }
      } catch {}
    }

    // 4. Extract Target Path
    let targetPath = url.pathname.substring(prefix.length) + url.search;
    if (!/^https?:\/\//i.test(targetPath)) {
      targetPath = "https://" + targetPath.replace(/^\/+/, "");
    }

    // 5. Whitelist Check
    const whiteList = parseWhiteList(env.WHITE_LIST);
    if (whiteList.length > 0 && !whiteList.some(needle => targetPath.includes(needle))) {
      return Response.redirect(`${url.origin}${prefix}error?code=403&msg=owner is not allowed`, 302);
    }

    // 6. GitHub Routing & JSDelivr Optimization
    try {
      const targetUrl = new URL(targetPath);
      if (!isGitHubUrl(targetUrl)) {
        return Response.redirect(`${url.origin}${prefix}error?code=403&msg=resource not allowed`, 302);
      }

      // JSDelivr Rewrite optimization
      if (env.USE_JSDELIVR === "1" && targetUrl.hostname === "github.com") {
        const ghBlob = new URLPattern({ pathname: '/:owner/:repo/blob/:ref/:path*' }).exec(targetUrl);
        if (ghBlob) {
          const { owner, repo, ref, path } = ghBlob.pathname.groups;
          return Response.redirect(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`, 302);
        }
      }

      // 7. Proxy & Headers
      const response = await proxy(targetUrl, request, env);
      const newHeaders = new Headers(response.headers);
      const origin = request.headers.get("origin");
      
      if (isAllowedOrigin(origin, env)) {
        newHeaders.set("access-control-allow-origin", origin);
        newHeaders.set("access-control-expose-headers", "*");
      }
      newHeaders.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
      
      return new Response(response.body, { status: response.status, headers: newHeaders });

    } catch (e) {
      return Response.redirect(`${url.origin}${prefix}error?code=400&msg=invalid target url`, 302);
    }
  },
};
