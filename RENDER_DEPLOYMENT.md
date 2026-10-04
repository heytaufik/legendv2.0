# Render deployment

## Before deploying

Session profiles, captured footprints, and simulated setup outcomes are stored in Neon PostgreSQL when `DATABASE_URL` is set. Without it, the app uses local JSON files under `DATA_DIR` (default `./data`); Render's ordinary service filesystem is ephemeral, so that fallback is not durable on Render.

The remote FYERS capture endpoint is disabled unless `LEGEND_CAPTURE_TOKEN` is configured. The desktop capture process must send the same token over HTTPS. Do not put this token in browser code, source control, or a URL.

## Create the Neon database

1. Create a Neon project using the [Neon Console](https://console.neon.tech/).
2. Copy the pooled connection string from the project's **Connect** panel. It contains database credentials; keep it private.
3. Add it to the Render service as the secret environment variable `DATABASE_URL`. For local development, put it in `.env` instead. Never commit `.env`.
4. On first startup, the app creates its JSON-document table and imports any existing local JSON documents whose database entries are still empty.

Neon Free can scale compute to zero while idle, so the first database operation after a quiet period may take longer. Database initialization errors prevent the app from starting rather than silently replacing saved history with empty data.

## Deploy the Render web service

1. Push this project to a GitHub repository and connect the repository in Render.
2. Use **New → Blueprint** and select the repository. Render reads `render.yaml` to create the Singapore-region Node web service, with `npm ci`, `npm start`, and `/api/health` as its health check. The Blueprint uses Render's free instance plan.
3. In the Blueprint setup form, enter the secret values for `DATABASE_URL`, `FYERS_APP_ID`, `FYERS_SECRET_ID`, and `LEGEND_CAPTURE_TOKEN`. Set `FYERS_REDIRECT_URI` to `https://YOUR-SERVICE.onrender.com/auth/callback`; enter the active futures symbols for `FYERS_NIFTY_SYMBOL` and `FYERS_SENSEX_SYMBOL`. Do not commit these values to GitHub or paste them in chat.
4. Register that exact HTTPS redirect URL in the FYERS developer settings, then deploy the Blueprint.
5. Open `https://YOUR-SERVICE.onrender.com/api/health` and confirm it reports `ok: true` and `persistence.mode: "postgres"`.
6. On the desktop running the FYERS capture, set `LEGEND_CAPTURE_URL` to `https://YOUR-SERVICE.onrender.com/api/fyers-orderflow` and set `LEGEND_CAPTURE_TOKEN` to the same secret configured in Render.
7. Open the public dashboard on the phone and use **Connect FYERS** to authorize the Render callback.

Neon keeps saved history separate from Render's filesystem. Render's free web-service plan may spin down after inactivity or restart; this can interrupt the live FYERS market socket and remote footprint capture. Neon protects persisted history, but it does not keep the Render service awake. Check Render's current plan limits before relying on uninterrupted market-hours capture.

## Forward numeric footprint from the desktop

On the desktop that can access the logged-in FYERS Order Flow chart, set these local `.env` values:

```text
LEGEND_CAPTURE_URL=https://YOUR-SERVICE.onrender.com/api/fyers-orderflow
LEGEND_CAPTURE_TOKEN=the-same-random-secret-configured-in-render
```

Then run `npm run capture:fyers`, log in to FYERS in the capture window, open the active futures Order Flow chart, and select the desired timeframe. The capture process forwards FYERS's numeric candle and price-level Ask/Bid payloads to the app over HTTPS. Keep that desktop process and chart running during market hours.

The dashboard's Render service does not log in to FYERS's chart or generate footprint data on its own. If the desktop capture process is offline, the app can still show saved history and server-side market-feed data, but it cannot receive new numeric chart footprint payloads.

## Local development

Leave `DATA_DIR` unset (or set it to `./data`), and leave `LEGEND_CAPTURE_URL` unset to capture to `http://127.0.0.1:3000/api/fyers-orderflow`. Loopback capture is allowed without a token when `LEGEND_CAPTURE_TOKEN` is unset.
