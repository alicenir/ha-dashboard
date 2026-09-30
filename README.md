# ha-dashboard

A Hebrew (RTL) wall-tablet dashboard for Home Assistant, served from its own container.

Six panels on one screen:

- **Electricity:** current gauge against your main breaker, a 6-hour graph with the peak, and daily, monthly and car-socket energy.
- **Weather:** now, hourly and a 4-day forecast.
- **Car:** battery, range, plug and charging state, charge limit, start/stop charging (TeslaMate sensors are detected automatically).
- **Home control:** lights and devices, plus quick actions like "all lights off" or a good-night script.
- **Tasks:** an HA to-do list: add, tap to complete, long-press to delete.
- **Info:** any sensors you like, e.g. dryer status, sunrise and sunset, devices on the network.

How it works:

- **Server-side bridge.** The container holds the HA token and talks to HA's WebSocket API. Browsers only talk to the container, so the token never reaches a browser.
- **Live.** State changes are pushed instantly; the forecast refreshes every 30 minutes and the power graph every 5.
- **Locked down.** The browser can only see and control entities that appear on the dashboard, and only through an allowlist of services. Locks and alarms can't be controlled.
- **Layout.** Fills the screen on a landscape tablet with no scrolling; two columns on a portrait tablet; one column on a phone.

## Install

### 1. Create a Home Assistant token

In Home Assistant: **Profile → Security → Long-lived access tokens → Create token**. Copy it; HA shows it only once.

### 2a. Portainer

1. On the host, create a folder for the settings file, for example `/opt/ha-dashboard`.
2. **Stacks → Add stack**, name it `ha-dashboard`, and paste [`docker-compose.yml`](docker-compose.yml).
3. Under **Environment variables**, add:

   | Name | Value |
   |---|---|
   | `HA_URL` | `http://<home-assistant-ip>:8123` |
   | `HA_TOKEN` | the token from step 1 |
   | `CONFIG_DIR` | the folder from step 1, e.g. `/opt/ha-dashboard` |
   | `TZ` | your time zone, e.g. `Asia/Jerusalem` |

4. **Deploy the stack**, then open `http://<docker-host-ip>:8090`.

### 2b. docker compose

```bash
git clone https://github.com/alicenir/ha-dashboard.git && cd ha-dashboard
cp .env.example .env        # fill in HA_URL and HA_TOKEN
docker compose up -d
```

Then open `http://<docker-host-ip>:8090`.

### Private repository

If the repository (and so the image) is private, Portainer needs credentials to pull it:

1. GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)** → generate a token with only `read:packages`.
2. Portainer → **Registries → Add registry → Custom registry**: URL `ghcr.io`, authentication on, your GitHub username, and the token as the password.

For docker compose, run `docker login ghcr.io` with the same username and token.

### Updating

Portainer: open the stack → **Update the stack** with **Re-pull image** enabled. docker compose: `docker compose pull && docker compose up -d`.

## Choosing entities: `dashboard.json`

Without a settings file, the dashboard auto-detects what it can: the weather entity, `sun.sun`, lights and TVs, the first to-do list, TeslaMate sensors (`sensor.tesla_battery_level` and siblings), people, and electricity sensors with names like `main`, `total` or `grid`.

To choose exactly, copy [`config/dashboard.example.json`](config/dashboard.example.json) to `dashboard.json` in your `CONFIG_DIR` and replace the entity IDs with yours. Changes are picked up within 10 seconds, with no restart.

Rules:

- Any key you leave out is auto-detected. Set a key to `null` to hide that item.
- `status`: pills in the top bar. A `person` pill can show a phone battery with `"battery": "sensor.xxx"`.
- `power.breaker`: your main breaker in amps; the gauge and the load warning scale to it.
- `controls.devices`: an entity ID string, or `{ "entity": "...", "name": "...", "icon": "mdi-icon-name" }`.
- `controls.actions`: `{ "type": "all_lights_off" }` turns off every light in the panel; `{ "entity": "script.x" }` runs a script, scene or button.
- `info` rows: `{ "entity": "...", "label": "...", "secondary": "...", "icon": "..." }`, or `{ "type": "sun" }`. A `secondary` sensor in minutes shows as "עוד X דק׳".
- `car.charge_switch`, `car.charge_button` and `car.charge_limit` (a `number` entity) enable charging controls. TeslaMate itself is read-only, so these need a Tesla integration that can send commands.

Icons are [Material Design Icons](https://pictogrammers.com/library/mdi/) names without the `mdi-` prefix, e.g. `tumble-dryer`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HA_URL` | (required) | Home Assistant address, e.g. `http://<home-assistant-ip>:8123` |
| `HA_TOKEN` | (required) | Long-lived access token |
| `CONFIG_DIR` | `./config` | Host folder mounted at `/config` (compose only) |
| `DASHBOARD_PORT` | `8090` | Host port (compose only) |
| `TZ` | `UTC` | Container time zone (log timestamps) |
| `READ_ONLY` | `false` | `true` makes the dashboard view-only |
| `CONFIG_PATH` | `/config/dashboard.json` | Settings file location inside the container |
| `ALLOWED_DOMAINS` | `light,switch,fan,input_boolean,cover,climate,media_player,scene,script,button,vacuum,number,input_number,todo` | Domains that may be controlled |

## Development

```bash
npm install
HA_URL=http://<home-assistant-ip>:8123 HA_TOKEN=... CONFIG_PATH=./config/dashboard.json npm start
```

Images are built by GitHub Actions on every push to `main` and published to `ghcr.io/alicenir/ha-dashboard` (`linux/amd64` and `linux/arm64`).
