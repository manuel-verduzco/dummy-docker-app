# Deploying to the Azure VM

Target: Ubuntu 24.04 x64, Docker + Compose v2 installed, user `azureuser`, ports 22 and 80 open.
Image: `ghcr.io/manuel-verduzco/dummy-docker-app`

No secrets live in this repo. If you need a token (see step 0), type it on the VM only.

## 0. One-time: make the image pullable

GitHub creates new ghcr.io packages as **private**, even from a public repo. Either:

- **Easiest for this test:** after the first workflow run, go to
  GitHub → your profile → Packages → `dummy-docker-app` → Package settings →
  Change visibility → Public. The VM then needs no login.
- **Or keep it private:** create a classic personal access token with only the `read:packages` scope, then on the VM:
  ```bash
  docker login ghcr.io -u manuel-verduzco
  ```
  Paste the token at the password prompt. It is stored in `~/.docker/config.json` on the VM, never in the repo.

## 1. First deployment

```bash
ssh azureuser@<VM_PUBLIC_IP>

mkdir -p ~/dummy-docker-app && cd ~/dummy-docker-app
curl -fsSLO https://raw.githubusercontent.com/manuel-verduzco/dummy-docker-app/main/docker-compose.prod.yml

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

Verify (from the VM, then from your PC at `http://<VM_PUBLIC_IP>/`):

```bash
curl http://localhost/health    # ok
curl http://localhost/          # Hello from Docker! Visits: 1
```

## 2. Update to a new version

Push to `main`, wait for the GitHub Action to go green, then on the VM:

```bash
cd ~/dummy-docker-app
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker image prune -f      # optional: remove old unused layers
```

`up -d` recreates only containers whose image changed. The Redis volume keeps the counter.

## 3. Roll back to a previous version

Every build is tagged with its full commit SHA. Find the SHA of a good commit
(`git log --oneline` locally, or the Actions run list, or the package's Versions page; use the full 40-character SHA).

```bash
cd ~/dummy-docker-app
IMAGE_TAG=<full-commit-sha> docker compose -f docker-compose.prod.yml up -d
```

If the tag isn't on the VM yet, Compose pulls it. Check what's running:

```bash
docker compose -f docker-compose.prod.yml ps
docker inspect --format '{{.Config.Image}}' dummy-docker-app-web-1
```

`IMAGE_TAG` only applies to that command. To make a pin survive future commands, put `IMAGE_TAG=<sha>` in a `.env` file next to the compose file (on the VM only), and delete the line to return to `latest`.

## Useful commands

```bash
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml restart web
docker compose -f docker-compose.prod.yml down        # stop; keeps the Redis volume
docker compose -f docker-compose.prod.yml down -v     # stop AND delete the counter data
```
