# Automatic hourly capture

Takes a screenshot of each TradingView chart layout and uploads it to Confluence Radar. Works with free TradingView accounts. It can run in the cloud on GitHub Actions (below), or on your own computer.

> TradingView's terms discourage automated access. This opens your own charts once an hour, the same as you would by hand, but use it at your own discretion.

## GitHub Actions (runs in the cloud every hour)

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

## On your own computer

### One-time setup

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

### Run it every hour

**Windows** (Task Scheduler), in a terminal in this folder:
```
schtasks /Create /SC HOURLY /TN "Confluence Radar capture" /TR "cmd /c cd /d \"%CD%\" && node capture.mjs >> capture.log 2>&1"
```

**Mac / Linux** (cron): run `crontab -e` and add (use your real folder path; `which node` shows node's path):
```
5 * * * * cd /path/to/capture && /usr/local/bin/node capture.mjs >> capture.log 2>&1
```

Results and errors go to `capture.log`. If a run says "Not signed in", repeat the login step for that profile.
