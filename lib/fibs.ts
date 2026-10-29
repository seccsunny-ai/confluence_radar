// Fib retracement levels drawn by the user, and finding when price first touches one.
import { z } from "zod";
import { normalizeTf } from "./signals";
import type { Candle } from "./trend";

export const FIB_RATIOS = [0.5, 0.618, 0.786] as const;
export const FIB_TFS = ["1h", "4h"];

export interface Fib {
  id: number;
  symbol: string;
  tf: string;
  direction: "bull" | "bear"; // green = bullish retest (buy), red = bearish retest (sell)
  high: number;
  low: number;
}

/**
 * A bullish fib is drawn from the swing low up to the swing high, so its retracement levels sit below the high.
 * A bearish fib is drawn from the swing high down to the low, so its levels sit above the low.
 */
export function fibLevels(f: Pick<Fib, "direction" | "high" | "low">): Array<{ ratio: number; price: number }> {
  const range = f.high - f.low;
  return FIB_RATIOS.map((ratio) => ({
    ratio,
    price: f.direction === "bull" ? f.high - ratio * range : f.low + ratio * range,
  }));
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
  tf: z.string().transform(normalizeTf).refine((tf) => FIB_TFS.includes(tf), "Fibs are for 1H or 4H."),
  direction: z.enum(["bull", "bear"]),
  high: z.coerce.number().positive(),
  low: z.coerce.number().positive(),
  note: z.string().trim().max(200).optional().nullable(),
}).refine((f) => f.high > f.low, "The swing high has to be above the swing low.");
