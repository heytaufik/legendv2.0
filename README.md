# legendv2.0

Flowdesk is a read-only FYERS market dashboard for NIFTY and SENSEX futures.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `FYERS_APP_ID` and `FYERS_SECRET_ID`.
4. Set the FYERS app Redirect URL to `http://127.0.0.1:3000/api/auth/callback`.
5. Run `npm start`, open `http://localhost:3000`, and connect FYERS.

Active futures symbols are discovered from FYERS symbol masters unless overridden with `FYERS_NIFTY_SYMBOL` or `FYERS_SENSEX_SYMBOL`.

## Orderflow

The chart builds candles, volume profile, and estimated delta/CVD from FYERS market updates. Buy/sell direction is inferred from tick-price changes; it is not exchange aggressor-side data. Session profiles are stored locally in `data/session-profiles.json` and retained for 14 trading sessions.

The app does not place orders. Never commit `.env` or access tokens.

## Tests

Run `npm test`.