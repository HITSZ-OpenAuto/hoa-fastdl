# HOA FastDL

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HITSZ-OpenAuto/hoa-fastdl)

HOA FastDL is a lightweight GitHub proxy and accelerator service built on Cloudflare Workers. It allows you to mirror and proxy various GitHub content including releases, archives, raw files, and more.

## Features

- **GitHub Content Proxy**: Supports releases, source code archives, tags, blobs, raw files, and gists.
- **Whitelist Security**: Restrict proxying to specific organizations or repositories using the `WHITE_LIST` setting.
- **jsDelivr Integration**: Optional rewriting of blob/raw links to jsDelivr for faster downloads.
- **CORS Support**: Configurable allowed origins for cross-origin requests.

## Configuration

Configuration is managed via environment variables in `wrangler.toml`:

| Variable | Description |
| :--- | :--- |
| `PREFIX` | Route prefix for the worker (must start and end with `/`). Example: `/`. |
| `WHITE_LIST` | Comma-separated substrings that must be in the target URL. |
| `USE_JSDELIVR` | "1" to rewrite blob/raw links to jsDelivr; "0" to proxy directly. |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins for CORS. |

## How it works?

The worker operates by intercepting incoming requests and rewriting them to fetch content from GitHub.

1.  **URL Extraction**: It removes the worker's domain and configured `PREFIX` from the request URL to determine the target GitHub resource.
2.  **Validation**: The target URL is matched against supported patterns (releases, archives, raw files, etc.) and checked against the optional `WHITE_LIST`.
3.  **Routing**:
    -   **jsDelivr**: If enabled, compatible file requests (blob/raw) are redirected to `cdn.jsdelivr.net` for faster delivery.
    -   **Direct Proxy**: Other requests are forwarded directly to GitHub. `blob` URLs are automatically converted to `raw` for file downloading.
4.  **Response Handling**: The worker streams the response from GitHub back to the client, handling redirects and adding necessary CORS headers.

## Examples

Assuming your worker is deployed at `https://gh.example.com` and `PREFIX` is set to `/`:

**Original GitHub URL:**
`https://github.com/HITSZ-OpenAuto/hoa-fastdl/archive/refs/heads/main.zip`

**Proxied URL:**
`https://gh.example.com/github.com/HITSZ-OpenAuto/hoa-fastdl/archive/refs/heads/main.zip`
