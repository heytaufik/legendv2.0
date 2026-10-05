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
6. Install `scripts/violentmonkey-fyers-capture.user.js` in Violentmonkey on the browser where you are logged into FYERS. From the Violentmonkey menu choose **Set Legend Render capture token** and enter the same `LEGEND_CAPTURE_TOKEN` configured in Render. The token is stored by Violentmonkey and is not embedded in the userscript.
7. Open the public dashboard on the phone and use **Connect FYERS** to authorize the Render callback. This authorization remains in the running server process and automatically reconnects the market socket after temporary drops. If the Render instance sleeps or restarts, authorize again after it wakes; the in-memory FYERS token cannot survive a server restart.

Neon keeps saved history separate from Render's filesystem. Render's free web-service plan may spin down after inactivity or restart; this can interrupt the live FYERS market socket and remote footprint capture. Neon protects persisted history, but it does not keep the Render service awake. Check Render's current plan limits before relying on uninterrupted market-hours capture.

## Forward numeric footprint from the desktop

The dashboard's **Orderflow Chart** only displays data; changing its timeframe does not create a FYERS capture. On the browser where you are logged into FYERS, install `scripts/violentmonkey-fyers-capture.user.js`, set the Render capture token from the Violentmonkey menu, open FYERS Order Flow, and change timeframe to trigger a capture. Confirm the FYERS page shows the **Legend capture · N responses forwarded to dashboard** badge.

The userscript forwards FYERS's numeric candle and price-level Ask/Bid payloads directly from the browser to the app over HTTPS. Keep the logged-in FYERS browser open during market hours. If the badge is missing, the userscript is not running on that page; if it reports an HTTP error, check the Render token and capture endpoint availability.

## Local development

Leave `DATA_DIR` unset (or set it to `./data`), and leave `LEGEND_CAPTURE_URL` unset to capture to `http://127.0.0.1:3000/api/fyers-orderflow`. Loopback capture is allowed without a token when `LEGEND_CAPTURE_TOKEN` is unset.
