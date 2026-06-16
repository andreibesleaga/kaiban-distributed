# Vercel Deployment Guide

Vercel is a frontend-focused platform. It does **not** support long-running Node.js processes or WebSocket servers natively, so only the **static viewer** can be deployed to Vercel. The gateway and agents must run elsewhere (Railway, Fly.io, GCP, AWS, etc.).

---

## What Can Run on Vercel

| Component             | Deploy on Vercel? | Notes                                                |
|-----------------------|-------------------|------------------------------------------------------|
| Static viewer (HTML)  | ✅ Yes             | `board.html`, `board.js`, `board.css`                |
| Gateway (Socket.IO)   | ❌ No              | Requires persistent WebSocket connection             |
| Agent workers         | ❌ No              | Long-running Node.js processes                       |
| Redis / BullMQ        | ❌ No              | Stateful service                                     |

---

## Deploying the Static Viewer to Vercel

### Step 1 — Project Structure

Create a `vercel.json` in the example you want to deploy:

```json
{
  "outputDirectory": ".",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options",        "value": "DENY" },
        { "key": "Referrer-Policy",        "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
```

Place it alongside `board.html` inside `examples/blog-team/viewer/`.

The viewer is self-contained (`board.html` + `board.js` + `board.css`) — there is nothing to copy; deploy `examples/blog-team/viewer/` as-is.

### Step 2 — Deploy via the Vercel CLI

```bash
# Install the CLI once
npm i -g vercel

# Deploy the blog-team viewer
cd examples/blog-team/viewer
vercel --prod
```

During the first deployment, Vercel will ask:

- **Project name**: `kaiban-blog-team-viewer` (or any name you choose)
- **Root directory**: `.` (current directory)
- **Framework**: Other

### Step 3 — Configure the Gateway URL

The viewer resolves the gateway address from the first of these sources (in priority order):

1. **`window.GATEWAY_URL` global** — set via a `<script>` block before `board.js` loads:

```html
<script>window.GATEWAY_URL = "https://your-gateway.railway.app";</script>
```

2. **`?gateway=` query parameter** — append `?gateway=https://your-gateway.railway.app` to the URL.

3. **Fallback** — `http://localhost:3000` (development default).

After deploying the gateway elsewhere, set the URL directly in `board.html` using option 1 above (the `window.GATEWAY_URL` global), or pass it at runtime via the `?gateway=` query parameter (option 2).

### Step 4 — Custom Domain (optional)

```bash
vercel domains add viewer.yourdomain.com
```

---

## Deploying the Gateway (on Railway)

Since Vercel cannot run the gateway, use Railway alongside it. See [RAILWAY.md](RAILWAY.md) for the full guide.

A common setup:

```
Vercel (static viewer)  ──→  Railway Gateway  ──→  Railway Redis
                                     └──────────────────┘
                                   Railway Agent Workers
```

Set `SOCKET_CORS_ORIGINS` on the Railway gateway to your Vercel viewer URL
(this is read by the Socket.io gateway and is required in production):

```
SOCKET_CORS_ORIGINS=https://kaiban-blog-team-viewer.vercel.app
```

---

## Vercel Limitations to Keep in Mind

- **Serverless functions** have a 10-second execution limit (Hobby tier) — not suitable for LLM calls.
- **No WebSocket support** in serverless functions — Socket.IO requires a separate server.
- **Managed Redis** is available via Vercel KV (powered by Upstash), but only through the REST API, not the standard Redis protocol. It is **not** compatible with BullMQ.

---

## Further Reading

- [Vercel Static Deployment](https://vercel.com/docs/deployments/overview)
- [Vercel CLI](https://vercel.com/docs/cli)
- [Vercel Custom Domains](https://vercel.com/docs/projects/domains)
- [Railway Deployment Guide](RAILWAY.md)
