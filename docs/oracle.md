# Running the hub on an Oracle Cloud Always Free VM

The same Docker setup as on the Mac, on a free always-on ARM machine in India: live prices and the
evening NSE jobs run even when your laptop is closed. Reached only through a Cloudflare Tunnel —
**no open ports**.

What you need: an Oracle Cloud account (a card is needed at sign-up; Always Free resources aren't
charged), a Cloudflare account with a domain for the tunnel ([tunnel.md](tunnel.md), Option B), and
your Fyers credentials.

> One Fyers login at a time. When the hub moves to the VM, **stop the hub on the Mac** (and any
> Tradex still using Fyers directly). The owner lock only protects one data directory on one
> machine; it can't see a second hub elsewhere.

## 1. Create the VM

Oracle Cloud console → **Compute → Instances → Create instance**:

- **Region:** your home region is fixed at sign-up — pick **India South (Hyderabad)** or **India West
  (Mumbai)** then. Close to NSE and Fyers, IST-local.
- **Image:** Canonical Ubuntu 24.04 (the *aarch64* build is chosen with the shape).
- **Shape:** Ampere → `VM.Standard.A1.Flex`, **1 OCPU / 6 GB** is plenty (the hub uses well under
  1 GB; the free ARM allowance is a few OCPUs and some GB in total — check the current limits on
  Oracle's Always Free page).
- **Networking:** a new VCN with a public subnet is fine; a public IP is only for SSH.
- **SSH key:** upload your public key.
- Boot volume: the default ~47 GB is enough for years of data plus backups.

"Out of capacity" for A1 in Indian regions is common: retry at a different time of day, or try
another availability domain. Upgrading the account to *Pay As You Go* (Always Free resources stay
free) makes capacity easier to get and stops Oracle from **reclaiming idle Always Free instances**
— a hub can look idle (low CPU) for a week, which is exactly what that reclamation targets.

## 2. Lock the network down

The hub listens on `127.0.0.1` inside the VM and the tunnel connects *out* to Cloudflare, so
nothing needs to come in except your SSH.

- **VCN → Security lists (or an NSG):** keep only ingress TCP 22, ideally from your own IP; delete
  any other ingress rule. Egress: allow all (the hub needs HTTPS out to Fyers, NSE and Cloudflare).
- **Inside Ubuntu:** Oracle's images ship iptables rules that already drop everything but SSH
  (`/etc/iptables/rules.v4`). Leave them — don't open 8787. Docker publishes the hub on
  `127.0.0.1:8787` only (see `compose.yaml`); never change that to `8787:8787`. (Docker writes its
  own iptables rules and bypasses `ufw`, which is one more reason never to publish on all
  interfaces.)
- Optional: drop public SSH entirely and use the OCI Bastion service or Cloudflare's SSH
  (Zero Trust → Access) instead.

## 3. Install Docker and the hub

```bash
ssh ubuntu@<public-ip>
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && exit        # log in again for the group to apply
ssh ubuntu@<public-ip>

git clone https://github.com/ice-009/market-data-hub.git && cd market-data-hub
cp .env.example .env && chmod 600 .env
nano .env       # FYERS_*, TUNNEL_TOKEN, and HUB_BACKUP_DIR=/data/backups
mkdir -p data   # owned by ubuntu (uid 1000) = the container's `node` user
```

Before relying on the VM, check that NSE's archive answers from a datacenter IP (it sometimes
blocks them):

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0" https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv
```

`200` is good. `403` means the NSE jobs will fail from here: the hub still serves broker data, and
`/v1/status` will flag the NSE files as stale.

Build and start (the image builds natively on ARM; the first build takes a few minutes):

```bash
docker compose --profile tunnel up -d --build
docker compose logs -f hub        # "listening", then the broker login and the NSE catch-up
docker compose exec hub node dist/cli.js keys create tradex --scopes history,live,fo
```

The tunnel's public hostname points at `http://hub:8787` ([tunnel.md](tunnel.md)). Check from your
laptop: `curl -H "Authorization: Bearer mdh_…" https://data.example.com/v1/status`.

## 4. Bring your data along (optional)

To keep what the Mac hub stored, copy a backup over instead of downloading it all again:

```bash
# on the Mac
npm run hub -- data backup --to ./backups
# stop the Mac hub, then:
scp backups/hub-*.db ubuntu@<public-ip>:market-data-hub/data/hub.db.new

# on the VM
docker compose stop hub
mv data/hub.db.new data/hub.db && rm -f data/hub.db-wal data/hub.db-shm
docker compose start hub
```

API keys come along (they're in the database), so clients keep working with the new URL.

## 5. Backups

With `HUB_BACKUP_DIR=/data/backups` the hub backs itself up every night (outside market hours,
newest 7 kept, `HUB_BACKUP_KEEP` to change) — inside the data volume, which protects against a bad
update or a corrupt file but not against losing the VM. Copy them off the machine as well, e.g.
pull them to your Mac now and then:

```bash
rsync -av ubuntu@<public-ip>:market-data-hub/data/backups/ ~/hub-backups/
```

or push them to OCI Object Storage (part of Always Free) with `rclone` or the `oci` CLI from a
cron job. `/v1/status` reports a problem when the newest backup is over two days old.

On-demand backup (safe while running): `docker compose exec hub node dist/cli.js data backup`.
Restore: stop the hub, copy the backup over `data/hub.db`, delete `data/hub.db-wal` and
`data/hub.db-shm`, start the hub.

## 6. Day to day

- **Updates:** `git pull && docker compose up -d --build`. Migrations run at start-up; restarting is
  safe at any time ([README → Live prices and restarts](../README.md#live-prices-and-restarts)).
- **Monitoring:** point an uptime checker at `https://data.example.com/v1/status?strict=1` with a key
  of its own (`keys create uptime --scopes history`); it answers 503 with the problems when data is
  stale or the live feed is down in market hours ([api.md](api.md#get-v1status)).
- **Time zone:** the hub works in IST internally whatever the VM's time zone is.
- **Reboots:** `restart: unless-stopped` brings the hub and tunnel back after a reboot; Docker
  starts at boot on Ubuntu by default.
