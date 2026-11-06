# Reaching the hub through a Cloudflare Tunnel (free)

The hub only listens on `127.0.0.1`. A Cloudflare Tunnel makes an outbound connection from your
machine to Cloudflare, so other machines (or a deployed app) can reach the hub over HTTPS without
opening any port on your router.

## Option A — quick test (no account, temporary URL)

```bash
brew install cloudflared
npm run dev                                   # or docker compose up -d
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints a random `https://….trycloudflare.com` URL that works until you stop it. Every `/v1`
call still needs an API key. Use this only for testing.

## Option B — permanent tunnel with your own hostname

Needs a free Cloudflare account and a domain on Cloudflare.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (type
   *Cloudflared*). Name it `market-data-hub`.
2. Copy the **tunnel token** and put it in `.env` as `TUNNEL_TOKEN=…` (never commit it).
3. Add a **public hostname**, e.g. `data.example.com`, with service:
   - `http://hub:8787` if you run the hub with Docker compose (the tunnel container reaches it by
     service name), or
   - `http://127.0.0.1:8787` if you run `cloudflared` directly on the Mac.
4. Start it:
   ```bash
   docker compose --profile tunnel up -d
   # or, without Docker:  cloudflared tunnel run --token "$TUNNEL_TOKEN"
   ```
5. Check: `curl -H "Authorization: Bearer mdh_…" https://data.example.com/v1/status`

### Optional: Cloudflare Access in front

Zero Trust → **Access → Applications → Add** a self-hosted app for `data.example.com` with a
**Service Auth** policy, and create a **service token**. Clients then send the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers as well as the hub key — two independent
checks before a request reaches your machine.

## On a Mac

- The hub only serves data while the Mac is awake and online. In **System Settings → Energy**, turn
  on "Prevent automatic sleeping when the display is off" during market hours, or move the same
  Docker setup to an always-on machine later (see docs/plan.md, Hosting).
- Docker Desktop: enable "Start Docker Desktop when you sign in" so the hub restarts after reboots
  (`restart: unless-stopped` is already set).
