# GitHub Proxy Cloudflare Worker (No UI)

A minimal Cloudflare Worker that proxies raw/release/tag GitHub URLs with:

- No frontend/UI (returns plain usage text on root)
- Anti-indexing (robots.txt + `X-Robots-Tag` on all responses)
- Whitelist support (substring match)
- CORS enabled for all origins

## How it works

- Call the worker with the target URL appended after the configured `PREFIX`.
- Supported targets include GitHub release/archive, blob/raw, git/info, raw.* and gist.* URLs.
- Optional jsDelivr rewriter for `blob/raw` URLs when `USE_JSDELIVR=1`.

Examples (with default `PREFIX="/"`):

- `/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`
- `/https://github.com/<owner>/<repo>/raw/<branch>/<path>`
- `/https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`

If you set `PREFIX="/gh/"`, then the same becomes:

- `/gh/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`

## Configure

Edit `wrangler.toml` under `[vars]`:

- `PREFIX`: Route prefix for the worker. Keep both leading and trailing slashes. Example: `"/gh/"`.
- `WHITE_LIST`: Comma-separated substrings that must appear in the target URL to allow proxying. Empty means allow all. Default is `"HITSZ-OpenAuto"`.
- `USE_JSDELIVR`: Set to `"1"` to rewrite GitHub `blob/raw` URLs to jsDelivr; `"0"` to proxy directly.

Anti-indexing is enforced by:

- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on every response
- `robots.txt` endpoint returning `Disallow: /`

## Deploy

- Install Wrangler: `npm i -g wrangler`
- Preview: `wrangler dev`
- Deploy: `wrangler deploy`

To bind the worker under a specific route (e.g. `/gh/*` on a zone), add a `[routes]` entry in `wrangler.toml` or configure via Cloudflare dashboard, and set `PREFIX` accordingly (e.g., `"/gh/"`).

## Notes

- This worker intentionally does not serve any UI or static frontend.
- CORS is permissive (`*`) and preflight is handled.
- On disallowed targets (by whitelist), the worker returns `403 blocked`.
- For unmatched paths, it returns a plain-text usage message with HTTP 400.

