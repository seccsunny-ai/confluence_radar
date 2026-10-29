// Swing market structure as LuxAlgo's "Smart Money Concepts" indicator draws it (swing structure only, not
// internal): pivots from its leg() logic with a swing length of 50 bars, and BOS/CHoCH when a candle closes
// through the last swing high or low.
import type { Candle } from "./trend";

export const SWING_LENGTH = 50;

export interface Pivot { price: number; t: number; i: number }

export interface StructureBreak {
  kind: "BOS" | "CHoCH";
  direction: "bull" | "bear";
  t: number; // the candle that closed through the level
  i: number;
  level: Pivot; // the swing high (bull) or swing low (bear) that was broken
  trendBefore: "bull" | "bear" | null;
}

export interface Structure {
  highs: Pivot[]; // swing highs, oldest first
  lows: Pivot[];
  breaks: StructureBreak[];
  trend: "bull" | "bear" | null;
}

/**
 * Replays the indicator bar by bar. leg() turns bearish when the high `size` bars back is above every high since,
 * which makes that bar a swing high (and the mirror for lows). A close crossing above the current swing high,
 * not crossed before, is a CHoCH when the swing trend was bearish and a BOS otherwise.
 * Pass only closed candles: the last one counts as closed.
 */
export function swingStructure(candles: Candle[], size = SWING_LENGTH): Structure {
  const highs: Pivot[] = [], lows: Pivot[] = [], breaks: StructureBreak[] = [];
  let leg: 0 | 1 = 0; // 0 bearish, 1 bullish, as in the script
  let prevLeg: 0 | 1 = 0;
  let trend: Structure["trend"] = null;
  let swingHigh: (Pivot & { crossed: boolean }) | null = null;
  let swingLow: (Pivot & { crossed: boolean }) | null = null;
  // ta.crossover(close, level) compares with the level as it stood on the previous bar
  let prevHighLevel = NaN, prevLowLevel = NaN;

  for (let i = 0; i < candles.length; i++) {
    // getCurrentStructure(size)
    if (i >= size) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - size + 1; k <= i; k++) { hi = Math.max(hi, candles[k].h); lo = Math.min(lo, candles[k].l); }
      const p = candles[i - size];
      if (p.h > hi) leg = 0;
      else if (p.l < lo) leg = 1;
      if (leg !== prevLeg) {
        if (leg === 1) { swingLow = { price: p.l, t: p.t, i: i - size, crossed: false }; lows.push({ price: p.l, t: p.t, i: i - size }); }
        else { swingHigh = { price: p.h, t: p.t, i: i - size, crossed: false }; highs.push({ price: p.h, t: p.t, i: i - size }); }
      }
      prevLeg = leg;
    }
    // displayStructure(): ta.crossover / ta.crossunder of close against the level
    const c = candles[i], prev = candles[i - 1];
    if (prev && swingHigh && !swingHigh.crossed && c.c > swingHigh.price && prev.c <= prevHighLevel) {
      breaks.push({ kind: trend === "bear" ? "CHoCH" : "BOS", direction: "bull", t: c.t, i, level: strip(swingHigh), trendBefore: trend });
      swingHigh.crossed = true;
      trend = "bull";
    }
    if (prev && swingLow && !swingLow.crossed && c.c < swingLow.price && prev.c >= prevLowLevel) {
      breaks.push({ kind: trend === "bull" ? "CHoCH" : "BOS", direction: "bear", t: c.t, i, level: strip(swingLow), trendBefore: trend });
      swingLow.crossed = true;
      trend = "bear";
    }
    prevHighLevel = swingHigh?.price ?? NaN;
    prevLowLevel = swingLow?.price ?? NaN;
  }
  return { highs, lows, breaks, trend };
}

const strip = (p: Pivot): Pivot => ({ price: p.price, t: p.t, i: p.i });
