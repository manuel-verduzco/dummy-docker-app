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

If Redis or the database is unreachable, the affected pages return `503` instead of crashing.

## Where the data lives

| Data | Where | Why there |
|------|-------|-----------|
| User accounts (name, password hash, visits, created, last login) | **PostgreSQL**, table `users` | Durable records that must never be lost, with constraints the database enforces itself |
| Sessions, login-attempt limits, the global counter | **Redis** | Fast and short-lived; losing it only logs people out |

The schema is created by SQL files in `migrations/`, applied automatically at startup and recorded in a `schema_migrations` table. A new schema change is just a new numbered file.

## How login works

- Users are stored in PostgreSQL with a **bcrypt** password hash, never the password. Every query passes values as parameters (`$1`, `$2`), so SQL injection isn't possible, and a unique index makes duplicate sign-ups impossible even when two arrive at once.
- Sessions live in Redis; the browser only holds a random session ID in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). The ID is regenerated on login.
- Failed logins are limited to 5 per IP per 15 minutes. Login errors never say whether the username exists.
- `SESSION_SECRET` signs the cookie. It comes from the environment (the VM's `.env`), never from a file in the repo. Locally a random one is generated per start.
- Set `REGISTRATION_OPEN=false` to close sign-ups.

This is a learning project: there's no email verification, password reset, or HTTPS-only enforcement beyond Caddy.

## Run locally

Requires Docker. Once, create a file named `.env` next to `docker-compose.yml` (it is git-ignored) with a password for the local database. Any value works:

```text
POSTGRES_PASSWORD=pick-anything-here
```

Then build and run:

```bash
docker compose up --build
```

Open http://localhost (port 80 maps to the app's port 3000), register, log in, and refresh to watch the counters go up. To look inside the database:

```bash
docker compose exec db psql -U app -d app -c "select id, username, visits, created_at, last_login_at from users"
```

To back up and restore the local database from Windows PowerShell, dump inside the container and copy the file out (PowerShell's `>` and pipes can corrupt the encoding):

```powershell
docker compose exec -T db sh -c "pg_dump -U app -d app --clean --if-exists > /tmp/backup.sql"
docker compose cp db:/tmp/backup.sql ./backup.sql
# restore:
docker compose cp ./backup.sql db:/tmp/backup.sql
docker compose exec db psql -U app -d app -q -f /tmp/backup.sql
```

The file holds password hashes, so delete it when you're done. (The Linux commands for the VM are in DEPLOY.md.)

Your accounts persist across restarts in the `pg-data` volume. `docker compose down -v` deletes that volume, and with it every account. `POSTGRES_PASSWORD` is only read when the volume is first created: changing it later does not change the database's password, so either keep it the same or delete the volume.

## Files

- `docker-compose.yml`: local dev, builds from source.
- `docker-compose.prod.yml`: for the VM. Uses the ghcr.io image, PostgreSQL and Redis with persistent volumes, and Caddy for automatic HTTPS.
- `db.js`, `migrations/`: the database connection, the migration runner and the `users` schema.
- `scripts/import-redis-users.js`: one-off copy of accounts that used to live in Redis into PostgreSQL.
- `Caddyfile`: Caddy's reverse-proxy config (hostname comes from `DOMAIN` in the VM's `.env`).
- `.github/workflows/build.yml`: on every push to `main`, builds `linux/amd64`, pushes `latest` and `<commit SHA>` tags, then deploys to the VM over SSH.
- `DEPLOY.md`: one-time setup (DNS, port 443, deploy key, secrets), updates, and rollback.

Image: `ghcr.io/manuel-verduzco/dummy-docker-app`
