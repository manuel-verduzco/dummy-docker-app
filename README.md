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
- `docker-compose.prod.yml`: for the VM, uses the ghcr.io image with a persistent Redis volume.
- `.github/workflows/build.yml`: builds `linux/amd64` and pushes `latest` and `<commit SHA>` tags on every push to `main`.
- `DEPLOY.md`: step-by-step VM deployment, update, and rollback.

Image: `ghcr.io/manuel-verduzco/dummy-docker-app`
