# ha-dashboard

A modern, standalone dashboard for Home Assistant, served from its own container.

- **Server-side bridge.** The container holds the HA token and talks to HA's WebSocket API. Browsers only talk to the container, so the token never reaches a browser and no CORS changes are needed in HA.
- **Live.** State changes are pushed instantly. Rooms come from your HA areas, so moving an entity to another area in HA moves it here too.
- **Safe defaults.** Only an allowlist of domains and services can be controlled. Locks and alarms are view-only unless you enable them. Camera, album-art and person pictures are proxied, so HA's access tokens aren't exposed.
- **Works everywhere.** Phone, tablet and desktop layouts, dark and light mode, installable as a home-screen app.

## Deploy in Portainer

1. In HA: **Profile → Security → Long-lived access tokens → Create token**.
2. In Portainer: **Stacks → Add stack**, paste `docker-compose.yml`.
3. Under **Environment variables**, add `HA_TOKEN` with the token.
4. Deploy, then open `http://<nas-ip>:8090`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HA_URL` | `http://192.168.50.29:8123` | Home Assistant base URL |
| `HA_TOKEN` | (required) | Long-lived access token |
| `PORT` | `8090` | Port the dashboard listens on |
| `READ_ONLY` | `false` | `true` makes the dashboard view-only |
| `ALLOWED_DOMAINS` | `light,switch,fan,input_boolean,cover,climate,media_player,scene,script,button,vacuum` | Domains that can be controlled. Add `lock` to allow locking/unlocking (asks for confirmation) |
| `EXCLUDE_ENTITIES` | (none) | Regex of entity IDs to hide |

Entities hidden or disabled in HA, and diagnostic/config entities, are not shown.

## What shows where

- **Header:** clock, weather (first `weather.*` entity), people (`person.*`), and a summary (lights on, climate running, open doors/windows, motion, media playing).
- **Rooms view:** one section per HA area with key sensors (temperature, humidity, doors, windows, motion) as chips, and controls as tiles. Entities without an area go under **Other**, collapsed by default.
- **Filters:** Lights, Climate, Media, Cameras and Sensors show one category across all rooms. The Sensors filter shows every sensor.

## Development

```bash
npm install
HA_URL=http://192.168.50.29:8123 HA_TOKEN=... npm start
```

Images are built by GitHub Actions on every push to `main` and published to `ghcr.io/alicenir/ha-dashboard` (`linux/amd64` and `linux/arm64`).
