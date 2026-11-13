// The periodic check's Prime Oscillator step: after each new candle close on 1H, 2H, 4H and 1D, works out the
// oscillator from Bitget candles, saves its value, and keeps a row per run of candles above +level or below -level.
import type postgres from "postgres";
import { historyPage, recentCandles, TF_MS } from "./market";
import { extremeRun, OSC_TFS, primeOscillator } from "./prime-osc";
import type { Candle } from "./trend";

const MAX_PER_RUN = 120; // the first runs catch up over a few checks instead of slowing one down
const NEW_MS = 2 * 3600_000; // a run first seen after it was already this old isn't sent to Telegram

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

/** Candles for the oscillator, oldest first, the last one still forming. Bitget serves about 90 daily candles per call, so 1D pages back further. */
async function oscCandles(symbol: string, tf: string): Promise<Candle[]> {
  const got = await recentCandles(symbol, tf, 1000);
  if (tf !== "1D" || !got.length) return got;
  for (let page = 0; page < 4 && got.length < 450; page++) {
    const older = await historyPage(symbol, tf, got[0].t);
    if (!older.length) break;
    got.unshift(...older);
  }
  return got;
}

/** Returns how many symbol and timeframe pairs were worked out. */
export async function checkOscillator(sql: postgres.Sql, symbols: string[], level: number, errors: string[]): Promise<number> {
  const last = new Map<string, number>();
  for (const r of await sql`SELECT symbol, tf, candle_t FROM osc_readings`) last.set(`${r.symbol}|${r.tf}`, new Date(r.candle_t).getTime());
  const due = symbols.flatMap((s) => OSC_TFS.map((tf) => [s, tf] as const)).filter(([s, tf]) => {
    const t = last.get(`${s}|${tf}`);
    return t == null || Date.now() >= t + 2 * TF_MS[tf]; // the candle after the last one read has closed
  }).slice(0, MAX_PER_RUN);
  let done = 0;
  await pool(due, 4, async ([symbol, tf]) => {
    let candles: Candle[];
    try {
      candles = (await oscCandles(symbol, tf)).slice(0, -1); // closed candles only, as the chart shows them once the bar ends
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return;
    }
    if (candles.length < 30) return;
    const osc = primeOscillator(candles);
    const i = osc.length - 1;
    if (!Number.isFinite(osc[i])) return;
    const closedAt = candles[i].t + TF_MS[tf];
    await sql`
      INSERT INTO osc_readings (symbol, tf, candle_t, value, prev_value, updated_at)
      VALUES (${symbol}, ${tf}, ${new Date(candles[i].t)}, ${osc[i]}, ${Number.isFinite(osc[i - 1]) ? osc[i - 1] : null}, now())
      ON CONFLICT (symbol, tf) DO UPDATE SET candle_t = EXCLUDED.candle_t, value = EXCLUDED.value,
        prev_value = EXCLUDED.prev_value, updated_at = now()`;
    const run = extremeRun(candles, osc, level);
    let keep: number | null = null;
    if (run) {
      // News if the last reading was from before it started (inside the level then), or its first candle closed
      // recently. A run already going when this symbol was first read isn't sent.
      const before = last.get(`${symbol}|${tf}`);
      const fresh = (before != null && run.startT > before) || Date.now() - (run.startT + TF_MS[tf]) < NEW_MS;
      const [row] = await sql`
        INSERT INTO osc_signals (symbol, tf, side, level, started_t, last_t, last_value, peak, sent)
        VALUES (${symbol}, ${tf}, ${run.side}, ${level}, ${new Date(run.startT)}, ${new Date(candles[i].t)}, ${osc[i]}, ${run.peak}, ${!fresh})
        ON CONFLICT (symbol, tf, side, started_t) DO UPDATE SET last_t = EXCLUDED.last_t, last_value = EXCLUDED.last_value,
          peak = EXCLUDED.peak, ended_t = NULL
        RETURNING id`;
      keep = row.id;
    }
    // Any other open run has ended: the candle just read closed back inside the level
    await sql`
      UPDATE osc_signals SET ended_t = ${new Date(closedAt)}
      WHERE symbol = ${symbol} AND tf = ${tf} AND ended_t IS NULL ${keep ? sql`AND id <> ${keep}` : sql``}`;
    done++;
  });
  await sql`DELETE FROM osc_signals WHERE ended_t < now() - interval '30 days'`;
  return done;
}
