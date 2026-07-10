# INITIALS! — self-hosted

A tiny Node/Express server + static client for the acronym party game.
Rooms live in server memory (no database needed) and are auto-purged after
6 hours of inactivity.

## Run it directly

```
npm install
npm start
```

Then open http://localhost:8420 — first person creates a room, everyone
else joins with the 4-character code.

## Run it in Docker

```
docker compose up -d --build
```

This builds the image and exposes port 8420. Check it's alive with
`curl localhost:8420/healthz`.

## Exposing it to friends

Anyone who wants to play needs to reach port 8420 on whatever machine is
running the container. Options, easiest first:

1. **Cloudflare Tunnel** (same pattern as jayhesse.com): add a new public
   hostname in your `cloudflared` config pointing at
   `http://localhost:8420` (or the container's Docker network address if
   cloudflared is itself containerized), e.g.:

   ```yaml
   ingress:
     - hostname: initials.jayhesse.com
       service: http://localhost:8420
     - service: http_status:404
   ```

   Restart the tunnel and the game is live at `https://initials.jayhesse.com`
   with no port forwarding needed.

2. **Reverse proxy on an existing Nginx instance** — proxy_pass to
   `127.0.0.1:8420` under a subdomain or path.

3. **Local network only** — if everyone's on the same Wi-Fi, just share
   `http://<host-machine-LAN-IP>:8420` (e.g. `http://10.10.10.109:8420`).

## Notes on scaling this up

- State is in-memory and single-process — fine for casual games, but a
  restart wipes any room in progress, and it won't work if you ever run
  multiple replicas behind a load balancer (each would have its own memory).
  If you want persistence, swap the `Map` in `server.js` for SQLite/Redis.
- No auth on room codes — anyone with the 4-character code can join, same
  as the original design. Fine for a party game, not for anything sensitive.
- The host's browser tab drives round timers/phase transitions. If the
  host closes their tab mid-game, the game pauses until they reopen it
  (or until you add a small server-side ticker instead — happy to build
  that if you want the game logic to live entirely on the server).
