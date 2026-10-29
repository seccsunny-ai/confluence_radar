// Candles from Bitget's public USDT perpetual futures market data (no API key needed).
// The screeners run on BITGET:xxxUSDT.P charts, so "BTCUSDT.P" here is Bitget's "BTCUSDT".
import type { Candle } from "./trend";

const BASE = process.env.BITGET_API_URL || "https://api.bitget.com";

// Bitget's daily candles default to UTC+8; the "utc" variants match TradingView's UTC daily bars.
const GRANULARITY: Record<string, { g: string; ms: number }> = {
  "5m": { g: "5m", ms: 5 * 60_000 },
  "15m": { g: "15m", ms: 15 * 60_000 },
  "30m": { g: "30m", ms: 30 * 60_000 },
  "1h": { g: "1H", ms: 3600_000 },
  "2h": { g: "2H", ms: 2 * 3600_000 },
  "4h": { g: "4H", ms: 4 * 3600_000 },
  "1D": { g: "1Dutc", ms: 86400_000 },
  "1W": { g: "1Wutc", ms: 7 * 86400_000 },
};

export const TF_MS: Record<string, number> = Object.fromEntries(Object.entries(GRANULARITY).map(([k, v]) => [k, v.ms]));

export function bitgetSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/\.P$/, "").replace(/[^A-Z0-9]/g, "");
}

async function call(path: string, params: Record<string, string | number>): Promise<string[][]> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: string[][] } | null;
    if (res.ok && json?.code === "00000") return json.data ?? [];
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Bitget ${params.symbol} ${params.granularity}: ${json?.msg ?? `HTTP ${res.status}`}`);
  }
}

const toCandles = (rows: string[][]): Candle[] =>
  rows.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).filter((c) => Number.isFinite(c.c));

/** The latest `limit` candles (max 1000), oldest first. The last one is still forming. */
export async function recentCandles(symbol: string, tf: string, limit = 300): Promise<Candle[]> {
  const g = GRANULARITY[tf];
  if (!g) throw new Error(`No candles for timeframe ${tf}.`);
  const rows = await call("/api/v2/mix/market/candles", {
    symbol: bitgetSymbol(symbol), productType: "USDT-FUTURES", granularity: g.g, limit: Math.min(limit, 1000),
  });
  return toCandles(rows).sort((a, b) => a.t - b.t);
}

/** Candles from `start` to now, oldest first, fetched in pages of up to 1000. */
export async function candlesSince(symbol: string, tf: string, start: number, maxPages = 4): Promise<Candle[]> {
  const g = GRANULARITY[tf];
  if (!g) throw new Error(`No candles for timeframe ${tf}.`);
  const byTime = new Map<number, Candle>();
  let end = Date.now();
  for (let page = 0; page < maxPages && end > start; page++) {
    const from = Math.max(start, end - 1000 * g.ms);
    const rows = await call("/api/v2/mix/market/candles", {
      symbol: bitgetSymbol(symbol), productType: "USDT-FUTURES", granularity: g.g,
      startTime: from, endTime: end, limit: 1000,
    });
    const got = toCandles(rows);
    if (!got.length) break;
    for (const c of got) byTime.set(c.t, c);
    end = Math.min(...got.map((c) => c.t)) - 1;
    if (end <= from) end = from - 1;
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
