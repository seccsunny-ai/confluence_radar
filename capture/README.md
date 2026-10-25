# Automatic hourly capture

Takes a screenshot of each TradingView chart layout and uploads it to Confluence Radar. Works with free TradingView accounts. It runs on your own computer, so the computer has to be on (and awake) for the hourly run.

> TradingView's terms discourage automated access. This opens your own charts once an hour, the same as you would by hand, but use it at your own discretion.

## One-time setup

1. Install [Node.js](https://nodejs.org) (LTS).
2. Open a terminal in this `capture` folder and run:
   ```
   npm install
   npx playwright install chromium
   ```
3. Copy `config.example.json` to `config.json` and fill it in:
   - `site`: your Confluence Radar address.
   - `password`: the `APP_PASSWORD` you set in Vercel, or leave empty.
   - `layouts`: one entry per chart. `url` is the chart layout's address (open the layout in TradingView and copy the browser address, like `https://www.tradingview.com/chart/AbCdEf12/`). `profile` is any name for the TradingView account that owns it. `tz` is the timezone the screener prints its times in (`+05:30` for IST, `+00:00` for UTC).
4. Sign in once per account. A browser window opens; sign in, then close the window:
   ```
   node capture.mjs login seccsunny
   node capture.mjs login mylgv30photos1
   ```
5. Test it:
   ```
   node capture.mjs
   ```
   It prints how many signals each upload produced. The last screenshot of each layout is saved in `shots/` so you can check the tables were fully drawn. If they were cut off, raise `viewport.height`; if they were still loading, raise `waitSeconds`.

## Run it every hour

**Windows** (Task Scheduler), in a terminal in this folder:
```
schtasks /Create /SC HOURLY /TN "Confluence Radar capture" /TR "cmd /c cd /d \"%CD%\" && node capture.mjs >> capture.log 2>&1"
```

**Mac / Linux** (cron): run `crontab -e` and add (use your real folder path; `which node` shows node's path):
```
5 * * * * cd /path/to/capture && /usr/local/bin/node capture.mjs >> capture.log 2>&1
```

Results and errors go to `capture.log`. If a run says "Not signed in", repeat the login step for that profile.
