# Deploying to the Azure VM

Target: Ubuntu 24.04 x64, Docker + Compose v2, user `azureuser`.
Image: `ghcr.io/manuel-verduzco/dummy-docker-app`

The stack (`docker-compose.prod.yml`) has three containers:

- `caddy`: terminates HTTPS (free Let's Encrypt certificate, auto-renewed) and proxies to the app
- `web`: the Node app (not exposed directly)
- `redis`: the counter, with a persistent volume

**No secrets live in this repo.** The SSH key, VM address, and host key are GitHub Actions secrets; the domain is in a `.env` file on the VM.

## 0. One-time setup

### 0a. Make the image pullable
GitHub creates ghcr.io packages as private. Set it to Public:
GitHub → your profile → Packages → `dummy-docker-app` → Package settings → Change visibility → Public.

### 0b. Azure: DNS name and port 443
In the Azure portal, for the VM `vm-docker-test`:

1. **Public IP → Configuration → DNS name label**: pick a name, e.g. `dummy-docker-test`.
   Your hostname becomes `dummy-docker-test.<region>.cloudapp.azure.com` (shown on the IP's overview page).
   Tip: set the IP **Assignment** to *Static* so it never changes.
2. **Networking → Network security group → Add inbound rule**: allow **TCP 443** (80 and 22 are already open).
   Caddy needs 80 *and* 443 reachable from the internet to get its certificate.

### 0c. A dedicated deploy key
On your PC (PowerShell). This key is only for deploying; don't reuse your personal key. Leave the passphrase empty:

```bash
ssh-keygen -t ed25519 -f $HOME\.ssh\dummy_deploy -C "github-actions-deploy"
```

Authorize its **public** half on the VM:

```bash
type $HOME\.ssh\dummy_deploy.pub | ssh azureuser@<VM_IP_OR_HOSTNAME> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Get the VM's host key (so GitHub can verify it's connecting to the right server):

```bash
ssh-keyscan -t ed25519 <VM_HOSTNAME>
```

### 0d. GitHub secrets
Repo → Settings → Secrets and variables → Actions → New repository secret. Add four:

| Secret | Value |
|---|---|
| `VM_HOST` | the VM hostname from 0b |
| `VM_USER` | `azureuser` |
| `VM_SSH_KEY` | the full contents of `dummy_deploy` (the **private** key, including the BEGIN/END lines) |
| `VM_KNOWN_HOSTS` | the full output line of `ssh-keyscan` from 0c |

Paste these only into the GitHub form. Never commit them or paste them into a file in the repo.

### 0e. Prepare the VM
Stop anything already using ports 80/443 (for example the previous stack), then set the domain:

```bash
cd ~/dummy-docker-app
docker compose -f docker-compose.prod.yml down      # old stack, if running; keeps volumes
echo "DOMAIN=<your-hostname>" > .env
```

Add the login session secret too. Generate it on the VM so it never exists anywhere else:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
```

User accounts now live in a PostgreSQL container, so the VM also needs its password. Generate it the same way, and **set it before the first deploy of this version**:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
```

PostgreSQL reads this variable only when it first creates its data volume. Changing the line later does **not** change the database's password, and the app would then fail to log in to it. Treat it as set-once, and don't regenerate it.

If either is missing, `docker compose` refuses to start and the deploy job fails; the running site is left untouched. To rotate the session secret later, replace that line and redeploy (everyone gets logged out).

The first automated deploy copies the new compose file and `Caddyfile` for you. To start it by hand instead:

```bash
curl -fsSLO https://raw.githubusercontent.com/manuel-verduzco/dummy-docker-app/main/docker-compose.prod.yml
curl -fsSLO https://raw.githubusercontent.com/manuel-verduzco/dummy-docker-app/main/Caddyfile
docker compose -f docker-compose.prod.yml up -d
```

## 1. Automatic deploys (the normal flow)

Push to `main` → the **build** job builds and pushes the image → the **deploy** job SSHes into the VM, writes `IMAGE_TAG=<commit SHA>` into `.env`, and runs `pull` + `up -d`.

Watch it in the Actions tab. Then check `https://<your-hostname>/`.

## 2. Manual update (if you need it)

```bash
cd ~/dummy-docker-app
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

## 3. Roll back to a previous version

Every build is tagged with its full commit SHA (`git log --format="%H %s"`).

```bash
cd ~/dummy-docker-app
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<full-commit-sha>/' .env
docker compose -f docker-compose.prod.yml up -d
```

The pin lives in `.env`, so it sticks until the next automatic deploy overwrites it. Note that **the next push to `main` deploys the new commit again**; to roll back permanently, revert the bad commit in git (`git revert <sha>`) and push.

## 4. Moving existing accounts from Redis to PostgreSQL (once)

Accounts created before the database existed live only in Redis. After the first deploy of this version, copy them over:

```bash
cd ~/dummy-docker-app
docker compose -f docker-compose.prod.yml exec web node scripts/import-redis-users.js
```

It's safe to run twice: existing accounts are skipped, and nothing is deleted from Redis, which stays as a backup of the old accounts. Until you run it, those people can't log in.

## 5. Backing up and restoring the user database

Redis can be rebuilt; the `users` table cannot. Take a backup (a plain SQL file) and keep a copy **off the VM**:

```bash
cd ~/dummy-docker-app
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U app -d app --clean --if-exists | gzip > users-$(date +%F).sql.gz
```

To restore (this replaces the current table contents):

```bash
gunzip -c users-2026-01-31.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U app -d app -q
```

A backup you have never restored is a hope, not a backup: try the restore on a copy first. `down -v` deletes the `pg-data` volume and every account in it; plain `down` keeps it.

## Troubleshooting

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 30 caddy   # certificate problems show here
docker compose -f docker-compose.prod.yml logs --tail 30 web
docker compose -f docker-compose.prod.yml logs --tail 30 db   # database startup or login problems
```

- **Caddy can't get a certificate:** check that port 443 *and* 80 are open in the NSG and the DNS name resolves to the VM's IP (`nslookup <hostname>`).
- **"port is already allocated":** another container (e.g. an old stack) holds port 80/443; `docker ps`, then remove it.
- **Deploy job fails at SSH:** check the four secrets, and that port 22 allows GitHub's runners (they come from many IPs, so don't restrict 22 to your own IP).
- `down -v` deletes the Redis counter **and** the certificates. Use plain `down` to keep them.
