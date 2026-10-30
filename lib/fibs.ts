// Fib retracement levels (drawn by the user, or from the swing structure in autofib.ts), and finding when price
// first touches one.
import { z } from "zod";
import { normalizeTf } from "./signals";
import type { Candle } from "./trend";

export const FIB_RATIOS = [0.5, 0.618, 0.786];
const HTF_RATIOS = [0.382, 0.5, 0.618, 0.786];
export const FIB_TFS = ["15m", "1h", "4h", "1D"]; // timeframes for fibs entered by hand
// Daily and weekly fibs are drawn on a log chart, so their levels are spaced by percentage rather than price.
export const LOG_TFS = ["1D", "1W"];

export const fibRatios = (tf?: string) => (tf && LOG_TFS.includes(tf) ? HTF_RATIOS : FIB_RATIOS);

export interface Fib {
  id: number;
  symbol: string;
  tf: string;
  direction: "bull" | "bear"; // green = bullish retest (buy), red = bearish retest (sell)
  high: number;
  low: number;
  source?: "manual" | "auto";
  forming?: boolean; // auto: the leg is still running, so its far end can still move
}

/**
 * A bullish fib is drawn from the swing low up to the swing high, so its retracement levels sit below the high.
 * A bearish fib is drawn from the swing high down to the low, so its levels sit above the low.
 * 1D and 1W get the 0.382 too, and log-scale levels (as TradingView draws them on a log chart).
 */
export function fibLevels(f: Pick<Fib, "direction" | "high" | "low"> & { tf?: string }): Array<{ ratio: number; price: number }> {
  const log = !!f.tf && LOG_TFS.includes(f.tf);
  const [hi, lo] = log ? [Math.log(f.high), Math.log(f.low)] : [f.high, f.low];
  return fibRatios(f.tf).map((ratio) => {
    const p = f.direction === "bull" ? hi - ratio * (hi - lo) : lo + ratio * (hi - lo);
    return { ratio, price: log ? Math.exp(p) : p };
  });
}

export interface Touch { t: number; ratio: number; level: number }

/**
 * First candle at or after `from` whose range reaches one of the levels, allowing `tolerancePct` percent of
 * the level on either side. When one candle reaches several levels, the one price meets first on its way
 * into the retracement wins (the 0.5 before the 0.618 before the 0.786).
 */
export function firstTouch(candles: Candle[], levels: Array<{ ratio: number; price: number }>, from: number, tolerancePct: number): Touch | null {
  const sorted = [...levels].sort((a, b) => a.ratio - b.ratio);
  for (const c of candles) {
    if (c.t < from) continue;
    for (const lv of sorted) {
      const tol = (lv.price * tolerancePct) / 100;
      if (c.l <= lv.price + tol && c.h >= lv.price - tol) return { t: c.t, ratio: lv.ratio, level: lv.price };
    }
  }
  return null;
}

export const FibInput = z.object({
  symbol: z.string().trim().min(1),
  tf: z.string().transform(normalizeTf).refine((tf) => FIB_TFS.includes(tf), "Fibs are for 15m, 1H, 4H or 1D."),
  direction: z.enum(["bull", "bear"]),
  high: z.coerce.number().positive(),
  low: z.coerce.number().positive(),
  note: z.string().trim().max(200).optional().nullable(),
}).refine((f) => f.high > f.low, "The swing high has to be above the swing low.");
