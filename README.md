# ReBWR

A live dashboard for RBWR servers.

It takes the public server list for RBWR from Roblox, merges it with the plant
telemetry published by the hydrogen API, and pushes the combined result to every
open browser over a WebSocket. What you get is a table of every server with
player counts, FPS and ping, plus the MW and points/sec totals for each unit and
a detail view you can open per server.

There's no database and no build step. The backend is one Express file; the
frontend is plain HTML, CSS and JS served out of `public/`.

## Running it locally

You need Node.js 18 or newer.

```bash
git clone https://github.com/certified-fluff/ReBWR.git
cd ReBWR
npm install
cp .env.example .env     # Windows: copy .env.example .env
npm start
```

Then open http://localhost:3000. `npm run dev` does the same thing.

No keys are required to get it running. If `RECAPTCHA_SECRET_KEY` is empty the
captcha gate is skipped entirely and the server tells you so at startup.

## Configuration

All settings come from the environment. `.env.example` lists them with comments.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port for both HTTP and the WebSocket. |
| `NODE_ENV` | `development` | In `production`, static files are cached for an hour and CORS is limited to `ALLOWED_ORIGIN`. |
| `ALLOWED_ORIGIN` | *(empty)* | The origin allowed in production. Nothing cross-origin is accepted while it's empty. |
| `POLL_INTERVAL_MS` | `30000` | How often the upstream APIs are polled. |
| `MAX_WS_CONNECTIONS` | `500` | Clients past this limit get closed with code `1013`. |
| `TRUST_PROXY` | `false` | Turn on behind nginx or Cloudflare so client IPs come from `X-Forwarded-For`. |
| `RECAPTCHA_SITE_KEY` | *(empty)* | Public reCAPTCHA v2 site key, rendered as a checkbox widget and handed to the browser through `/api/config`. |
| `RECAPTCHA_SECRET_KEY` | *(empty)* | Server-side secret. Without it, verification is skipped. |

## API

- `GET /health` — uptime, poll count, last fetch time, connected clients, memory.
- `GET /api/config` — the public client config.
- `GET /api/servers` — the latest snapshot as `{ servers, stats, meta }`.
- `GET /api/servers/:id` — one server plus global stats. `503` before the first
  poll finishes, `404` if the ID isn't there.
- `POST /api/verify-captcha` — takes `{ "token": "..." }` and checks it with Google.
- `WS /` — on the same port, push-only. The server sends `{ type: "update", data }`
  once on connect and again after every poll. It never reads from the client, and
  any data a client sends gets the connection closed with code `1003`.

Requests to `/api/*` are limited to 60 per minute per IP, and captcha checks to
10. JSON bodies are capped at 10 KB and WebSocket frames at 1 KB.

## Where the data comes from

- Roblox's public server endpoint for the RBWR universe
  (`games.roblox.com/v1/games/<universeId>/servers/Public`); the universe ID is
  hardcoded in `server.js` for now.
- The hydrogen API at `hydrogen.realisticbwr.org/api/public/servers`.

Both are fetched together with a 10 second timeout each. If one fails the merge
still happens with whatever arrived, and `meta.robloxApiAvailable` /
`meta.rbwrApiAvailable` tell you which side was down.

## Docker

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

Or without Compose:

```bash
docker build -t rbwr-monitor .
docker run -d --name rbwr-monitor --env-file .env -p 3000:3000 --memory 256m rbwr-monitor
```

Watch out for one thing: `docker-compose.yml` forwards port 3000 and also loads
your `.env`, so `PORT` needs to be `3000` there too. Leave it at something else
and the container listens on a port nothing is being forwarded to.

## PM2

```bash
npm run pm2          # pm2 start ecosystem.config.js
npm run pm2:logs
npm run pm2:stop
```

Logs land in `logs/output.log` and `logs/error.log`.

## Layout

```
server.js              polling, merging, HTTP and WebSocket handling
public/index.html      the page itself: captcha gate, stats bar, table, modals
public/app.js          captcha flow, WebSocket client, rendering, favorites
public/styles.css      styling
Dockerfile             node:20-alpine, runs as the non-root node user
docker-compose.yml     single service, 256 MB memory cap
ecosystem.config.js    PM2 definition
.env.example           environment template
```

`exp/` is scratch space for local experiments. It's in `.gitignore` and
`.dockerignore`, and the server has no routes for it.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the setup and what to check before opening a PR.

If you find a security problem, please contact the maintainer privately instead
of opening an issue.

## License

AGPL-3.0, see [LICENSE](LICENSE).

Worth knowing what that means here: if you run a modified copy of ReBWR and let
other people use it over a network, you have to offer them your source.