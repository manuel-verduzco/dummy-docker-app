# dummy-docker-app

A tiny Node.js app used to practice a container deployment workflow:

**GitHub Actions builds the image → pushes to ghcr.io → an Azure VM pulls and runs it.**

The app counts visits in Redis and replies `Hello from Docker! Visits: N`.

| Endpoint              | Behavior                                                         |
|-----------------------|------------------------------------------------------------------|
| `/`                   | Increments the global counter in Redis; shows login state        |
| `/health`             | Returns `ok`; never touches Redis, the counter, or sessions      |
| `/register`, `/login` | Create an account / log in (HTML forms)                          |
| `/dashboard`          | Login required; shows a per-user visit counter                   |
| `/logout` (POST)      | Ends the session                                                 |

If Redis is unreachable, pages return `503` instead of crashing.

## How login works

- Users are stored in Redis (`user:<name>`) with a **bcrypt** password hash, never the password.
- Sessions live in Redis; the browser only holds a random session ID in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). The ID is regenerated on login.
- Failed logins are limited to 5 per IP per 15 minutes. Login errors never say whether the username exists.
- `SESSION_SECRET` signs the cookie. It comes from the environment (the VM's `.env`), never from a file in the repo. Locally a random one is generated per start.
- Set `REGISTRATION_OPEN=false` to close sign-ups.

This is a learning project: there's no email verification, password reset, or HTTPS-only enforcement beyond Caddy.

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
