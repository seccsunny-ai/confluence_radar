// Fibs drawn automatically from the swing structure (LuxAlgo SMC, swing length 50) on 1H, 2H, 4H, 1D and 1W.
//
// Every swing BOS or CHoCH starts a new leg. After a bullish break (a close above the swing high) the leg starts at
// the lowest low between that swing high and the break, and runs to the highest high before the next break: a green
// fib from that low to that high, for a bullish retest. A bearish break is the mirror: a red fib from the highest
// high between the broken swing low and the break, down to the lowest low before the next break.
// A fib goes once a candle closes beyond either end (below its low or above its high), so as a rule only the latest
// leg's fib is left. The leg in progress is marked forming: its far end still moves.
// Before the first break, the last swing high and low mark the legs.
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

/** Every leg's fib that price hasn't closed beyond, oldest first. Pass only closed candles. */
export function legFibs(candles: Candle[], st: Structure = swingStructure(candles, SWING_LENGTH)): LegFib[] {
  const out: LegFib[] = [];
  const pushLeg = (up: boolean, iL: number, iH: number, forming: boolean) => {
    const high = candles[iH].h, low = candles[iL].l;
    if (!(high > low)) return;
    if (candles.slice(Math.max(iH, iL) + 1).some((c) => c.c < low || c.c > high)) return; // broken
    const anchorT = up ? candles[iL].t : candles[iH].t;
    const same = out.findIndex((f) => f.direction === (up ? "bull" : "bear") && f.anchorT === anchorT);
    if (same >= 0) out.splice(same, 1); // the later leg from the same start wins
    out.push({ direction: up ? "bull" : "bear", high, low, highT: candles[iH].t, lowT: candles[iL].t, anchorT, forming });
  };
  const argmin = (a: number, b: number) => { let m = a; for (let i = a; i <= b; i++) if (candles[i].l < candles[m].l) m = i; return m; };
  const argmax = (a: number, b: number) => { let m = a; for (let i = a; i <= b; i++) if (candles[i].h > candles[m].h) m = i; return m; };

  const breaks = st.breaks;
  for (let k = 0; k < breaks.length; k++) {
    const b = breaks[k];
    const last = k === breaks.length - 1;
    const to = last ? candles.length - 1 : breaks[k + 1].i - 1; // up to the candle before the next break
    let iL: number, iH: number;
    if (b.direction === "bull") {
      iL = argmin(b.level.i, b.i); // the low between the broken swing high and the break
      iH = argmax(iL, Math.max(to, iL));
    } else {
      iH = argmax(b.level.i, b.i);
      iL = argmin(iH, Math.max(to, iH));
    }
    pushLeg(b.direction === "bull", iL, iH, last);
  }

  // No break yet (a short history at swing length 50, as on many weekly charts): the move between the last
  // swing high and low is the leg, and the move since is the leg in progress.
  if (!breaks.length && st.highs.length && st.lows.length) {
    const h = st.highs[st.highs.length - 1].i, l = st.lows[st.lows.length - 1].i;
    const end = candles.length - 1;
    if (l < h) {
      pushLeg(true, l, h, false);
      pushLeg(false, argmin(h, end), h, true);
    } else {
      pushLeg(false, l, h, false);
      pushLeg(true, l, argmax(l, end), true);
    }
  }
  return out;
}
