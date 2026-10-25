# Confluence Radar

Upload hourly screenshots of two TradingView screeners and get a searchable history of every signal, plus a tracker that tells you when a Gold signal is followed by a same-direction BOS or CHoCH.

- **Divergence screener** ("My MTF Screener v6"): G🔥 Gold Buy, G❄ Gold Sell, V↑/V↓ VMC divergences, R↑/R↓ RSI divergences.
- **BOS/CHoCH screener** ("SMC Multi-Symbol Screener"): Int/Sw BOS↑↓ and Int/Sw CHoCH↑↓.

## How it works

1. Drop, choose or paste screenshots. A vision model (Google Gemini's free tier by default, or Claude) reads each table cell by cell; the app then parses the labels and dates itself.
2. Every signal is stored once per symbol, timeframe, signal type and time. Symbols are never removed: when a symbol drops out of the screener its history stays, and newer screenshots add new signals to it.
3. Tabs:
   - **Gold → BOS/CHoCH**: every Gold signal with the BOS/CHoCH that followed it on the same symbol in the same direction (G🔥 → bullish, G❄ → bearish), within the window for the Gold signal's timeframe: 15m → 2 days, 1h → 7 days, 4h → 14 days, 1D → 21 days. Status is *confirmed*, *watching* (window still open) or *expired*. The structure signal can be on any timeframe; tick "same timeframe" to require a match.
   - **Signals**: filter by signal type, timeframe, age (e.g. G🔥 in the last 24 hours, the screener's ⚡ window) and symbol.
   - **Symbols**: the latest signal of each kind for every symbol and timeframe.
   - **Uploads**: every screenshot processed, its warnings, and a delete button for a bad read.

### Timezones

The cell times have no year or timezone, so the upload box asks which offset each screener prints in. The samples show the divergence screener in IST (UTC+05:30) and the BOS/CHoCH screener in UTC, which are the defaults. The snapshot time is read from TradingView's header ("Oct 25, 2026 16:00 UTC+5:30") and decides the year. If a signal comes out later than the snapshot, the upload shows a warning that the timezone setting is probably wrong.

### Limits

The BOS/CHoCH screener only shows the latest event per cell, so if two structure breaks print between screenshots, only the second is seen. Hourly uploads keep that gap small.

## Deploy on Vercel

1. Import this repository in Vercel.
2. Storage → add **Neon** (Postgres) from the Marketplace and connect it to the project. This sets `DATABASE_URL`. Tables are created on first use.
3. Settings → Environment Variables:
   - `GEMINI_API_KEY`: free key from https://aistudio.google.com/apikey (no card needed). Free-tier limits are far above 2 screenshots an hour. Google may use free-tier inputs to improve its products.
   - `APP_PASSWORD` (recommended): the site then asks for a password (any username). Without it anyone with the URL can use up your Gemini quota.
   - Optional: `GEMINI_MODEL` (default `gemini-3.8-flash`). When a model is busy or retired the app moves on to other Flash models, including the replacement Google names in its error.
   - Optional, paid instead of Gemini: `ANTHROPIC_API_KEY` with `EXTRACTION_MODEL` (default `claude-opus-5-5`) and `EXTRACTION_EFFORT`. Used only when `GEMINI_API_KEY` is not set.
4. Redeploy.

## Automatic hourly capture

See [capture/README.md](capture/README.md): a small script that screenshots your TradingView layouts every hour and uploads them, for free TradingView accounts.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL and GEMINI_API_KEY
npm run dev
DATABASE_URL=postgres://... npm test   # drops and recreates the tables in that database
```
