# Legend market dashboard

A read-only FYERS market dashboard for NIFTY and SENSEX futures. The app does not place orders.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and configure the FYERS credentials. Set `DATABASE_URL` to use Neon; without it, application history is stored as local JSON under `data/`.
4. Set the FYERS redirect URL to `http://127.0.0.1:3000/auth/callback`.
5. Run `npm start` and open `http://localhost:3000`.

## Deploy to Render

Use the included [`render.yaml`](./render.yaml) Blueprint and follow [`RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md). Database history requires the Neon pooled connection string configured as the secret `DATABASE_URL`.

## Orderflow

The dashboard derives candles, volume profile, and estimated delta/CVD from FYERS market updates. Buy/sell direction is inferred from price changes; it is not exchange aggressor-side data. Numeric chart footprint data requires the separate desktop capture process described in the deployment guide. Opening the dashboard's Orderflow chart does not capture FYERS data; run `npm run capture:fyers` on the desktop and open the FYERS Order Flow chart in the capture window.

## Tests

Run `npm test`.
