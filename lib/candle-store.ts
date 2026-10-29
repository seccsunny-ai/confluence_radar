// Longer candle history than Bitget serves in one call. Its candle endpoints return at most about 90 days at a
// time (540 4H candles, 90 daily, 13 weekly), so swing length 50 on 4H, 1D and 1W needs older candles paged in
// and kept. They're fetched back a few pages per run until there are enough, then only the newest are added.
import type postgres from "postgres";
import { historyPage, recentCandles, TF_MS } from "./market";
import type { Candle } from "./trend";

export interface StoredCandles {
  candles: Candle[]; // closed candles, oldest first, at most `want`
  complete: boolean; // false while older history is still being fetched
}

export async function storedCandles(sql: postgres.Sql, symbol: string, tf: string, want: number, maxPages = 8): Promise<StoredCandles> {
  const ms = TF_MS[tf];
  const recent = (await recentCandles(symbol, tf, 1000)).slice(0, -1); // the last one is still forming
  if (!recent.length) return { candles: [], complete: true };
  const [have] = await sql`
    SELECT min(t)::float8 AS oldest, max(t)::float8 AS newest, count(*)::int AS n FROM candles WHERE symbol = ${symbol} AND tf = ${tf}`;
  let done = !!(await sql`SELECT done FROM candle_sets WHERE symbol = ${symbol} AND tf = ${tf}`)[0]?.done;
  const got: Candle[] = [...recent];
  let pages = 0;

  // Fill any gap between the stored candles and the recent ones; if it can't be closed now, start over.
  let end = recent[0].t;
  let stored = have.n as number;
  if (stored) {
    while (end - ms > have.newest && pages < maxPages) {
      const page = await historyPage(symbol, tf, end);
      pages++;
      if (!page.length) break;
      got.push(...page);
      end = page[0].t;
    }
    if (end - ms > have.newest) {
      await sql`DELETE FROM candles WHERE symbol = ${symbol} AND tf = ${tf}`;
      stored = 0;
      done = false;
    }
  }

  // Then further back, until there are enough or the symbol's history runs out
  let start = stored ? Math.min(have.oldest, end) : end;
  let count = stored + got.filter((c) => !stored || c.t > have.newest).length;
  while (!done && pages < maxPages) {
    if (count >= want) { done = true; break; }
    const page = await historyPage(symbol, tf, start);
    pages++;
    if (!page.length) { done = true; break; }
    got.push(...page);
    start = page[0].t;
    count += page.length;
  }
  if (!done && count >= want) done = true;

  const rows = [...new Map(got.map((c) => [c.t, { symbol, tf, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }])).values()];
  for (let i = 0; i < rows.length; i += 1000) {
    await sql`
      INSERT INTO candles ${sql(rows.slice(i, i + 1000), "symbol", "tf", "t", "o", "h", "l", "c")}
      ON CONFLICT (symbol, tf, t) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c`;
  }
  await sql`
    INSERT INTO candle_sets (symbol, tf, done) VALUES (${symbol}, ${tf}, ${done})
    ON CONFLICT (symbol, tf) DO UPDATE SET done = EXCLUDED.done`;
  const all = await sql`
    SELECT t::float8 AS t, o, h, l, c FROM candles WHERE symbol = ${symbol} AND tf = ${tf} ORDER BY t DESC LIMIT ${want + 1}`;
  if (all.length > want) await sql`DELETE FROM candles WHERE symbol = ${symbol} AND tf = ${tf} AND t <= ${all[want].t}`;
  return { candles: (all.slice(0, want) as unknown as Candle[]).reverse(), complete: done };
}

const DAY = 86400_000;

/** Weekly candles (weeks from Monday 00:00 UTC, as TradingView and Bitget draw them) from closed daily ones. Weeks not yet over are left out. */
export function weeklyFromDaily(days: Candle[], now = Date.now()): Candle[] {
  const monday = (t: number) => t - ((new Date(t).getUTCDay() + 6) % 7) * DAY - (t % DAY);
  const current = monday(now);
  const weeks: Candle[] = [];
  for (const d of days) {
    const w = monday(d.t);
    if (w >= current) break;
    const last = weeks[weeks.length - 1];
    if (last && last.t === w) {
      last.h = Math.max(last.h, d.h);
      last.l = Math.min(last.l, d.l);
      last.c = d.c;
    } else weeks.push({ t: w, o: d.o, h: d.h, l: d.l, c: d.c });
  }
  return weeks;
}
