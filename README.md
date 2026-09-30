# ha-dashboard

A Hebrew (RTL) wall-tablet dashboard for Home Assistant, served from its own container.

Six panels on one screen: home electricity (gauge, 6-hour graph, daily/monthly energy), weather (hourly and 4-day forecast), Tesla (battery, range, plug, charge limit, charging), home control (lights and devices plus quick actions), tasks (an HA to-do list) and info (dryer, sunrise/sunset, network devices).

- **Server-side bridge.** The container holds the HA token and talks to HA's WebSocket API. Browsers only talk to the container, so the token never reaches a browser.
- **Live.** State changes are pushed instantly; the forecast refreshes every 30 minutes and the power graph every 5.
- **Locked down.** The browser can only see and control entities that appear on the dashboard, and only through an allowlist of services. Locks and alarms can't be controlled.
- **Layout.** Fills the screen on a landscape tablet with no scrolling; two columns on a portrait tablet; one column on a phone.

## Deploy in Portainer

1. In HA: **Profile → Security → Long-lived access tokens → Create token**.
2. On the NAS, create `/share/Docker/ha-dashboard/` and (optionally) put `dashboard.json` in it (see below).
3. In Portainer: **Stacks → Add stack**, paste `docker-compose.yml`, and add `HA_TOKEN` under **Environment variables**.
4. Deploy, then open `http://192.168.50.8:8090`.

## Choosing entities: `dashboard.json`

Without a settings file, the dashboard auto-detects what it can: the weather entity, `sun.sun`, lights and TVs, the first to-do list, TeslaMate sensors (`sensor.tesla_battery_level` and siblings), people, and electricity sensors with names like `main`/`total`/`grid`.

To choose exactly, copy `config/dashboard.example.json` to `/share/Docker/ha-dashboard/dashboard.json` and replace the entity IDs with yours. Changes are picked up within 10 seconds, with no restart.

Rules:
- Any key you leave out is auto-detected. Set a key to `null` to hide that item.
- `controls.devices` items can be an entity ID string, or `{ "entity": "...", "name": "...", "icon": "mdi-icon-name" }`.
- `controls.actions`: `{ "type": "all_lights_off" }` turns off every light in the panel; `{ "entity": "script.x" }` runs a script, scene or button.
- `info` rows: `{ "entity": "...", "label": "...", "secondary": "...", "icon": "..." }`, or `{ "type": "sun" }`. A `secondary` sensor in minutes shows as "עוד X דק׳".
- `car.charge_switch` / `car.charge_button` / `car.charge_limit` (a `number` entity) enable charging controls. TeslaMate itself is read-only, so these need a Tesla integration that can send commands.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HA_URL` | `http://192.168.50.29:8123` | Home Assistant base URL |
| `HA_TOKEN` | (required) | Long-lived access token |
| `PORT` | `8090` | Port the dashboard listens on |
| `CONFIG_PATH` | `/config/dashboard.json` | Settings file location |
| `READ_ONLY` | `false` | `true` makes the dashboard view-only |
| `ALLOWED_DOMAINS` | `light,switch,fan,input_boolean,cover,climate,media_player,scene,script,button,vacuum,number,input_number,todo` | Domains that may be controlled |

## Development

```bash
npm install
HA_URL=http://192.168.50.29:8123 HA_TOKEN=... CONFIG_PATH=./config/dashboard.json npm start
```

Images are built by GitHub Actions on every push to `main` and published to `ghcr.io/alicenir/ha-dashboard` (`linux/amd64` and `linux/arm64`).
