// Market structure trend from swing highs and lows.
//
// Swings are confirmed pivots: a high (low) with PIVOT_BARS lower highs (higher lows) on each side.
// Higher high + higher low = uptrend, lower high + lower low = downtrend. Once a trend is established, a higher
// high in a downtrend (or a lower low in an uptrend) marks a potential change; the trend flips when the matching
// higher low (lower high) confirms it. Price breaking the last swing high/low before the pivot confirms counts too.

export interface Candle { t: number; o: number; h: number; l: number; c: number }
export type Trend = "up" | "down" | "range";

export interface Swing { price: number; t: number; kind: "HH" | "LH" | "HL" | "LL" | "H" | "L" }

export interface TrendResult {
  trend: Trend;
  potential: "up" | "down" | null; // the direction the trend may be turning to
  since: number | null; // time of the swing that established the current trend
  lastHigh: Swing | null;
  lastLow: Swing | null;
  price: number;
  note: string;
}

export const PIVOT_BARS = 5;

export function swings(candles: Candle[], bars = PIVOT_BARS): Array<Swing & { i: number; side: "high" | "low" }> {
  const out: Array<Swing & { i: number; side: "high" | "low" }> = [];
  let prevH: number | null = null, prevL: number | null = null;
  for (let i = bars; i < candles.length - bars; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= bars && (isHigh || isLow); k++) {
      // ties on the left side break the pivot so a flat top only counts once
      if (candles[i - k].h >= c.h || candles[i + k].h > c.h) isHigh = false;
      if (candles[i - k].l <= c.l || candles[i + k].l < c.l) isLow = false;
    }
    if (isHigh) {
      out.push({ i, side: "high", price: c.h, t: c.t, kind: prevH === null ? "H" : c.h > prevH ? "HH" : "LH" });
      prevH = c.h;
    }
    if (isLow) {
      out.push({ i, side: "low", price: c.l, t: c.t, kind: prevL === null ? "L" : c.l < prevL ? "LL" : "HL" });
      prevL = c.l;
    }
  }
  return out;
}

export function analyzeTrend(candles: Candle[], bars = PIVOT_BARS): TrendResult {
  const price = candles.length ? candles[candles.length - 1].c : NaN;
  const sw = swings(candles, bars);
  let trend: Trend = "range";
  let potential: TrendResult["potential"] = null;
  let since: number | null = null;
  let lastHigh: (typeof sw)[number] | null = null, lastLow: (typeof sw)[number] | null = null;

  for (const s of sw) {
    if (s.side === "high") lastHigh = s; else lastLow = s;
    const hk = lastHigh?.kind, lk = lastLow?.kind;
    if (hk === "HH" && lk === "HL") {
      if (trend !== "up") since = s.t;
      trend = "up"; potential = null;
    } else if (hk === "LH" && lk === "LL") {
      if (trend !== "down") since = s.t;
      trend = "down"; potential = null;
    } else if (trend === "down" && s.kind === "HH") {
      potential = "up";
    } else if (trend === "up" && s.kind === "LL") {
      potential = "down";
    }
  }

  // Price already past the last swing, before a new pivot can confirm it.
  let note = "";
  if (trend === "down" && !potential && lastHigh) {
    const after = candles.slice(lastHigh.i + 1);
    const top = Math.max(...after.map((c) => c.h));
    if (top > lastHigh.price) { potential = "up"; note = `price went above the last lower high ${fmtPrice(lastHigh.price)}`; }
  } else if (trend === "up" && !potential && lastLow) {
    const after = candles.slice(lastLow.i + 1);
    const bottom = Math.min(...after.map((c) => c.l));
    if (bottom < lastLow.price) { potential = "down"; note = `price went below the last higher low ${fmtPrice(lastLow.price)}`; }
  }
  if (!note && potential === "up") note = `higher high ${fmtPrice(lastHigh!.price)} in a downtrend`;
  if (!note && potential === "down") note = `lower low ${fmtPrice(lastLow!.price)} in an uptrend`;

  const strip = (s: (typeof sw)[number] | null): Swing | null => (s ? { price: s.price, t: s.t, kind: s.kind } : null);
  return { trend, potential, since, lastHigh: strip(lastHigh), lastLow: strip(lastLow), price, note };
}

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "?";
  const abs = Math.abs(p);
  const digits = abs >= 1000 ? 1 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return String(Number(p.toFixed(digits)));
}
