# Vercel Deployment Guide

Vercel is a frontend-focused platform. It does **not** support long-running Node.js processes or WebSocket servers natively, so only the **static viewer** can be deployed to Vercel. The gateway and agents must run elsewhere (Railway, Fly.io, GCP, AWS, etc.).

---

## What Can Run on Vercel

| Component             | Deploy on Vercel? | Notes                                                |
|-----------------------|-------------------|------------------------------------------------------|
| Static viewer (HTML)  | ✅ Yes             | `board.html`, `board.js`, `board.css`, `sw.js`       |
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

### Step 2 — Shared Assets

The viewer loads assets from a relative path (`../../shared/viewer/board-base.js`). On Vercel each example is its own deployment, so you need to copy the shared files in or serve them from a public URL.

Simplest approach — copy the shared files before deploying:

```bash
# From the repo root
cp -r examples/shared/viewer examples/blog-team/viewer/shared
```

Then update `board.html` to reference `./shared/board-base.js` instead of `../../shared/viewer/board-base.js`.

### Step 3 — Deploy via the Vercel CLI

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

### Step 4 — Configure the Gateway URL

The viewer reads the gateway address from the `data-gateway` attribute on `<body>`. After deploying the gateway elsewhere, open the Vercel project's **Environment Variables** settings and inject the URL at build time, or set it directly in `board.html`:

```html
<body data-gateway="https://your-gateway.railway.app">
```

### Step 5 — Custom Domain (optional)

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

Set `CORS_ORIGIN` on the Railway gateway to your Vercel viewer URL:

```
CORS_ORIGIN=https://kaiban-blog-team-viewer.vercel.app
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
