# HOA FastDL

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/HITSZ-OpenAuto/hoa-fastdl)

HOA FastDL is a high-performance GitHub proxy and accelerator service built on Cloudflare Workers. It allows you to mirror and proxy various GitHub content including releases, archives, raw files, and more.

## Features

- **GitHub Content Proxy**: Supports releases, source code archives, tags, blobs, raw files, and gists.
- **Whitelist Security**: Restrict proxying to specific organizations or repositories using the `WHITE_LIST` setting.
- **jsDelivr Integration**: Optional rewriting of blob/raw links to jsDelivr for faster downloads.
- **CORS Support**: Configurable allowed origins for cross-origin requests.
- **Cloudflare Assets**: Includes a simple frontend served directly via Cloudflare Assets.

## Configuration

Configuration is managed via environment variables in `wrangler.toml`:

| Variable | Description |
| :--- | :--- |
| `PREFIX` | Route prefix for the worker (must start and end with `/`). Example: `/`. |
| `WHITE_LIST` | Comma-separated substrings that must be in the target URL. |
| `USE_JSDELIVR` | "1" to rewrite blob/raw links to jsDelivr; "0" to proxy directly. |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins for CORS. |

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) and npm installed.
- A Cloudflare account and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) configured.

### Steps

1. **Clone the repository:**

   ```bash
   git clone https://github.com/HITSZ-OpenAuto/hoa-fastdl.git
   cd hoa-fastdl
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure `wrangler.toml`:**

   Edit `wrangler.toml` to customize your environment variables or worker name.

4. **Deploy to Cloudflare:**

   ```bash
   npm run deploy
   ```

## License

This project is licensed under the MIT License.
