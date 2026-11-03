# dummy-docker-app

A tiny Node.js app used to practice a container deployment workflow:

**GitHub Actions builds the image → pushes to ghcr.io → an Azure VM pulls and runs it.**

The app counts visits in Redis and replies `Hello from Docker! Visits: N`.

| Endpoint  | Behavior                                              |
|-----------|-------------------------------------------------------|
| `/`       | Increments the counter in Redis and returns it        |
| `/health` | Returns `ok`; never touches Redis or the counter      |

If Redis is unreachable, `/` returns `503` instead of crashing.

## Run locally

Requires Docker. Builds the image from source:

```bash
docker compose up --build
```

Then open http://localhost (port 80 maps to the app's port 3000) and refresh to watch the counter go up.

## Files

- `docker-compose.yml`: local dev, builds from source.
- `docker-compose.prod.yml`: for the VM. Uses the ghcr.io image, a persistent Redis volume, and Caddy for automatic HTTPS.
- `Caddyfile`: Caddy's reverse-proxy config (hostname comes from `DOMAIN` in the VM's `.env`).
- `.github/workflows/build.yml`: on every push to `main`, builds `linux/amd64`, pushes `latest` and `<commit SHA>` tags, then deploys to the VM over SSH.
- `DEPLOY.md`: one-time setup (DNS, port 443, deploy key, secrets), updates, and rollback.

Image: `ghcr.io/manuel-verduzco/dummy-docker-app`
