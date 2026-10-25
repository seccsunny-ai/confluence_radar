# Text upload format

Paste this into the site under **Or paste signals as text**. No AI runs on the server for text uploads.

```
CAPTURED: 2026-10-25 16:00 +05:30
TZ: +05:30
BTCUSDT.P, 15m, G🔥, 22 Oct 15:15
BTCUSDT.P, 15m, ⚡ V↓, 25 Oct 09:15
BTCUSDT.P, 1h, R↑, 24 Oct 08:30
TZ: +00:00
BTCUSDT.P, 15m, ⚡ Int BOS↓, 25 Oct 08:15
PEPEUSDT.P, 15m, ⚡ Int CHoCH↑, 25 Oct 10:00
```

- **One signal per line:** `SYMBOL, TIMEFRAME, SIGNAL, TIME`. Commas, `|` or tabs all work as separators.
- **SIGNAL** can be the label as printed (`G🔥`, `G❄`, `V↑`, `V↓`, `R↑`, `R↓`, `Int BOS↑`, `Sw CHoCH↓`, and so on), the code (`GOLD_BUY`, `GOLD_SELL`, `VMC_BULL`, `RSI_BEAR`, `INT_BOS_BULL`, `SW_CHOCH_BEAR`, and so on), or the name (`Gold Buy`). A leading `⚡` marks it as recent and is optional.
- **TIME** is as printed in the table, e.g. `25 Oct 15:15`, without a year. `2026-10-25 15:15` also works.
- **`CAPTURED:`** (optional) is when the screenshot was taken, which decides the year. TradingView's header text such as `Oct 25, 2026 16:00 UTC+5:30` also works. Without it, the time of the upload is used.
- **`TZ:`** (optional) sets the timezone of the times on the lines after it. Without it, the site uses the timezones chosen under the upload box: IST for the divergence screener and UTC for BOS/CHoCH by default.
- Empty lines, lines starting with `#`, a `SYMBOL, TIMEFRAME, SIGNAL, TIME` header and ``` fences are ignored.

## Prompt for the Gemini app

Paste this into gemini.google.com, attach the screenshot(s), and copy the reply into the site:

```
Transcribe the TradingView screener table(s) in the attached screenshot(s) into this exact text format, and output only a single code block.

First line: CAPTURED: followed by the date and time from the small text at the very top of the screenshot (e.g. "Oct 25, 2026 16:00 UTC+5:30"). Leave this line out if there is no such text.

Then one line per signal: SYMBOL, TIMEFRAME, SIGNAL, TIME
- SYMBOL exactly as printed (e.g. BTCUSDT.P).
- TIMEFRAME is the column header (15m, 1h, 4h, 1D).
- Each table cell can hold several signals on separate lines; write one output line for each of them. Skip empty cells and "-".
- SIGNAL exactly as printed, keeping the ⚡ in front when the cell shows it: one of G🔥 (Gold Buy, orange flame), G❄ (Gold Sell, snowflake), V↑, V↓, R↑, R↓, Int BOS↑, Int BOS↓, Sw BOS↑, Sw BOS↓, Int CHoCH↑, Int CHoCH↓, Sw CHoCH↑, Sw CHoCH↓. Bullish labels are usually green or blue, bearish ones red or orange; use the colour to check every arrow.
- TIME exactly as printed, e.g. 25 Oct 15:15. In the BOS/CHoCH table the time is on the line under the label.
- Read dimmed (older) text too; copy every date and time digit by digit.

Example:
CAPTURED: Oct 25, 2026 16:00 UTC+5:30
BTCUSDT.P, 15m, G🔥, 22 Oct 15:15
BTCUSDT.P, 15m, ⚡ V↓, 25 Oct 09:15
PEPEUSDT.P, 15m, ⚡ Int CHoCH↑, 25 Oct 10:00
```
