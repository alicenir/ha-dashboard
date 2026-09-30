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

### 2. Install with Portainer

#### Before you start

1. **Settings folder.** On the Docker host, create a folder for the optional `dashboard.json`, for example `/opt/ha-dashboard`. The container only reads it.
2. **Private repository only.** If the repository (and so the image) is private, Portainer needs credentials to pull the image:
   1. GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)** → **Generate new token (classic)**. Tick only `read:packages` (add `repo` too if you'll use Option B below). Fine-grained tokens don't work with GHCR.
   2. Portainer → **Registries → Add registry → Custom registry**:

      | Field | Value |
      |---|---|
      | Name | `GHCR` |
      | Registry URL | `ghcr.io` |
      | Authentication | on |
      | Username | your GitHub username |
      | Password | the token |

#### Option A: paste the compose file (simplest)

1. In Portainer, pick your environment (e.g. `local`) → **Stacks** → **+ Add stack**.
2. **Name:** `ha-dashboard`.
3. **Build method:** **Web editor**. Paste the contents of [`docker-compose.yml`](docker-compose.yml).
4. Scroll to **Environment variables** → **+ Add an environment variable** for each:

   | Name | Value | Required |
   |---|---|---|
   | `HA_URL` | `http://<home-assistant-ip>:8123` | yes |
   | `HA_TOKEN` | the token from step 1 | yes |
   | `CONFIG_DIR` | the settings folder, e.g. `/opt/ha-dashboard` | recommended |
   | `TZ` | your time zone, e.g. `Asia/Jerusalem` | no |
   | `DASHBOARD_PORT` | host port if `8090` is taken | no |
   | `READ_ONLY` | `true` for a view-only dashboard | no |

   Tip: **Advanced mode** lets you paste them all at once as `NAME=value` lines.
5. Click **Deploy the stack**.

#### Option B: deploy from the Git repository (updates itself)

Portainer clones the repository and uses its `docker-compose.yml`, so changes to the compose file reach you without copy-pasting.

1. **Stacks** → **+ Add stack** → **Name:** `ha-dashboard`.
2. **Build method:** **Repository**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Repository URL | `https://github.com/alicenir/ha-dashboard` |
   | Repository reference | `refs/heads/main` |
   | Compose path | `docker-compose.yml` |
   | Authentication | on only if the repo is private: GitHub username + a classic token with `repo` scope |

4. **GitOps updates** (optional): turn on **Automatic updates**, mechanism **Polling**, interval e.g. `5m`. Also enable **Re-pull image** so new image builds are picked up, not only compose changes.
5. Add the same **Environment variables** as in Option A. Set `CONFIG_DIR` explicitly: the default `./config` would point inside Portainer's copy of the repository.
6. Click **Deploy the stack**.

#### Check that it's running

1. **Containers** → `ha-dashboard` should show **running** and, after about 20 seconds, **healthy**.
2. Open its **Logs**. You should see:

   ```
   Authenticated to HA 2026.x
   Loaded 812 entities; dashboard uses 27
   ```

3. Open `http://<docker-host-ip>:8090` (or your `DASHBOARD_PORT`). The pill in the top bar should say **מחובר**.

#### Updating

- **Option A:** **Stacks** → `ha-dashboard` → **Editor** tab → **Update the stack**, with **Re-pull image and redeploy** switched on.
- **Option B with GitOps:** automatic. Otherwise open the stack → **Pull and redeploy**.
- **Settings only** (`dashboard.json`): just edit the file; it's reloaded within 10 seconds, no redeploy needed.

#### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Deploy fails: `Set HA_URL ...` or `Set HA_TOKEN ...` | The environment variable is missing or misspelled in the stack. |
| Deploy fails: `pull access denied` / `unauthorized` | Private image without registry credentials. Add the GHCR registry (see *Before you start*). |
| Deploy fails: `port is already allocated` | Something else uses 8090. Set `DASHBOARD_PORT` to a free port. |
| Log: `HA rejected the token (auth_invalid)` | The token is wrong or was deleted. Create a new one in HA and update `HA_TOKEN`. |
| Log: `HA connection closed, retrying` / `ECONNREFUSED` | Wrong `HA_URL`, or a firewall blocks the Docker host from reaching HA on port 8123. |
| Page shows **מנותק** | The page reached the dashboard but the dashboard can't reach HA. Check the container logs. |
| A panel says to configure something | Auto-detection didn't find a matching entity. Add it to `dashboard.json`. |

### 3. Install with docker compose

```bash
git clone https://github.com/alicenir/ha-dashboard.git && cd ha-dashboard
cp .env.example .env        # fill in HA_URL and HA_TOKEN
docker compose up -d
```

Then open `http://<docker-host-ip>:8090`. If the image is private, run `docker login ghcr.io` first with your GitHub username and a `read:packages` token. To update: `docker compose pull && docker compose up -d`.

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
