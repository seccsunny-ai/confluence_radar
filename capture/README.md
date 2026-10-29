# Automatic hourly capture

Opens each TradingView chart layout, reads the signals the screeners write to **Pine Logs**, and uploads them to Confluence Radar as text. A layout with `"mode": "screenshot"`, or no `mode`, uploads a screenshot instead (the older way).

Pine Logs mode needs the export versions of the screeners (the ones that write `# Confluence Radar: …` entries) on the layout. If a layout has two screeners, both are read. Trends, fibs and Telegram alerts run on the site itself and need nothing from here.

## On your computer (recommended)

This runs with your own TradingView logins on your home connection. Your computer has to be on (and not asleep) for the hourly run.

1. Install [Node.js](https://nodejs.org) (LTS) and Google Chrome.
2. Download this `capture` folder (or the whole repository), open a terminal in it and run:
   ```
   npm install
   ```
3. Copy `config.example.json` to `config.json` and fill in:
   - `site`: your Confluence Radar address, `https://confluence-radar.vercel.app`. Use that address, not one ending in `-sunny-b0d4.vercel.app`: Vercel Authentication protects those, so uploads get "HTTP 401". `password`: your `APP_PASSWORD`, or empty.
   - `layouts`: one entry per chart layout. `url` is the layout's address (open it in TradingView and copy the address bar, like `https://www.tradingview.com/chart/AbCdEf12/`). `profile` is a name for the TradingView account that owns it: `trading` for the divergence screeners, `diyvol` for the SMC screener.
   - `browser`: `"chrome"` uses your installed Chrome, which Google sign-in accepts. These are separate, script-only browser windows; your normal Chrome profiles are not touched.
4. Sign in once per account. A Chrome window opens; sign in to TradingView, then close the window:
   ```
   node capture.mjs login trading
   node capture.mjs login diyvol
   ```
5. Test it:
   ```
   node capture.mjs
   ```
   It prints how many signals each upload produced. If it says it found no entries, look at `shots/<name>.png` to see what the browser saw, and try a bigger `waitSeconds`. To watch it work, add `"headless": false` to the config.
6. Run it every hour (see **Run it every hour** below). On Windows, also untick "Start the task only if the computer is on AC power" in Task Scheduler if you use a laptop.

Without `"browser": "chrome"` it uses Playwright's own Chromium; install that with `npx playwright install chromium`. Google sign-in may refuse that browser, so sign in with your TradingView email and password, or use Chrome.

> TradingView's terms discourage automated access. This opens your own charts once an hour, the same as you would by hand, but use it at your own discretion.

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

## GitHub Actions (runs in the cloud every hour, alternative)

This also works with your computer off, but TradingView may sign out logins it sees from cloud servers.

The workflow `.github/workflows/capture.yml` runs at 5 minutes past every hour. It needs one repository secret, `CAPTURE_CONFIG`.

1. **Get each account's login cookies.** In Chrome, sign in to tradingview.com with the account, press F12, open Application → Cookies → `https://www.tradingview.com`, and copy the values of `sessionid` and `sessionid_sign`. For the second account, use a separate Chrome profile or an incognito window. Close that window without logging out, because logging out cancels the cookies.
2. **Get each chart layout's address**: open the layout and copy the browser address, like `https://www.tradingview.com/chart/AbCdEf12/`.
3. **Add the secret.** On GitHub go to the repository's Settings → Secrets and variables → Actions → New repository secret. Name it `CAPTURE_CONFIG` and paste:
   ```json
   {
     "site": "https://confluence-radar.vercel.app",
     "password": "",
     "layouts": [
       { "name": "divergence", "url": "https://www.tradingview.com/chart/XXXXXXXX/", "tz": "+05:30",
         "sessionid": "...", "sessionid_sign": "..." },
       { "name": "bos-choch", "url": "https://www.tradingview.com/chart/YYYYYYYY/", "tz": "+00:00",
         "sessionid": "...", "sessionid_sign": "..." }
     ],
     "viewport": { "width": 1100, "height": 1700 },
     "waitSeconds": 25
   }
   ```
   `password` is your `APP_PASSWORD`, or empty. `tz` is the timezone the screener prints its times in.
4. **Test it.** Open the Actions tab → "Hourly TradingView capture" → Run workflow. The log prints how many signals each upload produced. If a run fails, its screenshots are attached to the run as "shots", so you can see what the browser saw.

The cookies are kept in GitHub's encrypted secrets and never appear in the code or logs. They expire eventually, and TradingView may sign out logins it sees from cloud servers. When a run says "rejected the saved login cookies", copy fresh values into the secret.
