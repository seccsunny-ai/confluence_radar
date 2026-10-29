// Fibs drawn automatically from the swing structure (LuxAlgo SMC, swing length 50) on 1H, 2H, 4H, 1D and 1W.
//
// Price moves in legs from one swing CHoCH to the next (a BOS continues the leg). An up leg starts at the lowest
// low before its bullish CHoCH and runs to the highest high before the bearish CHoCH that ends it: a green fib
// from that low to that high, for a bullish retest. A down leg is the mirror: a red fib from its high to its low.
// A fib stays valid after the leg ends, until a candle closes beyond its anchor (below the green fib's low,
// above the red fib's high). The leg in progress gets a fib too, marked as forming, whose far end still moves.
import { swingStructure, SWING_LENGTH, type Structure } from "./structure";
import type { Candle } from "./trend";

export const AUTO_FIB_TFS = ["1h", "2h", "4h", "1D", "1W"];

export interface LegFib {
  direction: "bull" | "bear"; // bull = green
  high: number;
  low: number;
  highT: number;
  lowT: number;
  anchorT: number; // where the leg started: the low of a green fib, the high of a red one
  forming: boolean;
}

/** Every leg's fib that price hasn't broken, oldest first. Pass only closed candles. */
export function legFibs(candles: Candle[], st: Structure = swingStructure(candles, SWING_LENGTH)): LegFib[] {
  const starts = st.breaks.filter((b) => b.kind === "CHoCH" || b.trendBefore === null);
  const out: LegFib[] = [];
  const argmin = (a: number, b: number) => { let m = a; for (let i = a; i <= b; i++) if (candles[i].l < candles[m].l) m = i; return m; };
  const argmax = (a: number, b: number) => { let m = a; for (let i = a; i <= b; i++) if (candles[i].h > candles[m].h) m = i; return m; };

  for (let k = 0; k < starts.length; k++) {
    const from = k ? starts[k - 1].i + 1 : 0; // the move before this CHoCH, back to the previous one
    const to = k + 1 < starts.length ? starts[k + 1].i : candles.length - 1; // the bar of the CHoCH that ends the leg
    const up = starts[k].direction === "bull";
    let iL: number, iH: number;
    if (up) {
      iL = argmin(from, starts[k].i);
      iH = argmax(iL, to);
      iL = argmin(iL, iH);
    } else {
      iH = argmax(from, starts[k].i);
      iL = argmin(iH, to);
      iH = argmax(iH, iL);
    }
    const high = candles[iH].h, low = candles[iL].l;
    if (!(high > low)) continue;
    const broken = candles.slice(Math.max(iH, iL) + 1).some((c) => (up ? c.c < low : c.c > high));
    if (broken) continue;
    out.push({
      direction: up ? "bull" : "bear", high, low, highT: candles[iH].t, lowT: candles[iL].t,
      anchorT: up ? candles[iL].t : candles[iH].t, forming: k === starts.length - 1,
    });
  }
  return out;
}
