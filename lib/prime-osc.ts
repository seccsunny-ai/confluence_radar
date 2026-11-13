// The main line of the owner's "Prime Oscillator+" TradingView indicator, worked out here from Bitget candles so no
// screener or capture is needed. Same formula and defaults as the Pine script (Oscillator Length 14, Low-Lag
// Smoothing 3, Sensitivity 1.1): RSI, Stochastic, CCI and MFI averaged, zero-lag EMA, Ehlers super smoother, then
// scaled by its 150-bar standard deviation and squashed with tanh to about ±105.
// Values follow Pine's ta.* rules (SMA-seeded EMA/RMA, population stdev, na until a window is full), so they match the
// chart once a few hundred candles of history are in.
import type { Candle } from "./trend";

export const OSC_TFS = ["1h", "2h", "4h", "1D"];
export const OSC_LEN = 14;
export const OSC_SMOOTH = 3;
export const OSC_GAIN = 1.1;

const na = (x: number) => !Number.isFinite(x);

function sma(src: number[], n: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = n - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      if (na(src[k])) { ok = false; break; }
      s += src[k];
    }
    if (ok) out[i] = s / n;
  }
  return out;
}

/** Pine's EMA-style recursion: seeded with the SMA of the first full window, restarted after a gap. */
function seeded(src: number[], n: number, alpha: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  const avg = sma(src, n);
  for (let i = 0; i < src.length; i++) {
    if (na(src[i])) continue;
    out[i] = i > 0 && !na(out[i - 1]) ? alpha * src[i] + (1 - alpha) * out[i - 1] : avg[i];
  }
  return out;
}
const ema = (src: number[], n: number) => seeded(src, n, 2 / (n + 1));
const rma = (src: number[], n: number) => seeded(src, n, 1 / n);

function rsi(src: number[], n: number): number[] {
  const up = src.map((x, i) => (i ? Math.max(x - src[i - 1], 0) : NaN));
  const dn = src.map((x, i) => (i ? Math.max(src[i - 1] - x, 0) : NaN));
  const u = rma(up, n);
  const d = rma(dn, n);
  return u.map((a, i) => (na(a) || na(d[i]) ? NaN : d[i] === 0 ? 100 : a === 0 ? 0 : 100 - 100 / (1 + a / d[i])));
}

function stoch(c: Candle[], n: number): number[] {
  return c.map((k, i) => {
    if (i < n - 1) return NaN;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, c[j].h); lo = Math.min(lo, c[j].l); }
    return hi === lo ? NaN : (100 * (k.c - lo)) / (hi - lo);
  });
}

function cci(src: number[], n: number): number[] {
  const mean = sma(src, n);
  return src.map((x, i) => {
    if (na(mean[i])) return NaN;
    let dev = 0;
    for (let j = i - n + 1; j <= i; j++) dev += Math.abs(src[j] - mean[i]);
    dev /= n;
    return dev === 0 ? NaN : (x - mean[i]) / (0.015 * dev);
  });
}

function mfi(src: number[], vol: number[], n: number): number[] {
  return src.map((_, i) => {
    if (i < n) return NaN;
    let upper = 0, lower = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const ch = src[j] - src[j - 1];
      if (ch > 0) upper += vol[j] * src[j];
      if (ch < 0) lower += vol[j] * src[j];
    }
    return lower === 0 ? 100 : upper === 0 ? 0 : 100 - 100 / (1 + upper / lower);
  });
}

function stdev(src: number[], n: number): number[] {
  const mean = sma(src, n);
  return src.map((_, i) => {
    if (na(mean[i])) return NaN;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

function superSmoother(src: number[], len: number): number[] {
  const a1 = Math.exp((-1.414 * Math.PI) / len);
  const c2 = 2 * a1 * Math.cos((1.414 * Math.PI) / len);
  const c3 = -a1 * a1;
  const c1 = 1 - c2 - c3;
  const out = new Array<number>(src.length).fill(NaN);
  const nz = (x: number | undefined, y: number) => (x === undefined || na(x) ? y : x);
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (na(x)) continue;
    out[i] = (c1 * (x + nz(src[i - 1], x))) / 2 + c2 * nz(out[i - 1], x) + c3 * nz(out[i - 2], x);
  }
  return out;
}

const tanh = (x: number) => {
  const e = Math.exp(2 * Math.max(Math.min(x, 20), -20));
  return (e - 1) / (e + 1);
};

/** The main oscillator line for each candle (NaN while there isn't enough history yet). */
export function primeOscillator(c: Candle[], len = OSC_LEN, smooth = OSC_SMOOTH, gain = OSC_GAIN): number[] {
  const close = c.map((k) => k.c);
  const hlc3 = c.map((k) => (k.h + k.l + k.c) / 3);
  const vol = c.map((k) => k.v ?? 0);
  const noVol = vol.every((v) => !v);
  const r = rsi(close, len);
  const st = sma(stoch(c, len), 3);
  const cc = cci(hlc3, len);
  const mf = noVol ? r : mfi(hlc3, vol, len);
  const raw = c.map((_, i) => {
    const cciN = Math.max(Math.min(cc[i] / 2, 100), -100);
    return ((r[i] - 50) * 2 + (st[i] - 50) * 2 + cciN + (mf[i] - 50) * 2) / 4;
  });
  const zLen = Math.max(smooth, 2);
  const lag = Math.max(Math.floor((zLen - 1) / 2), 0);
  const zl = ema(raw.map((x, i) => (i >= lag ? x + (x - raw[i - lag]) : NaN)), zLen);
  const sm = superSmoother(zl, smooth + 2);
  const dev = stdev(sm, 150);
  return sm.map((x, i) => {
    if (na(x)) return NaN;
    const d = na(dev[i]) || dev[i] === 0 ? 25 : dev[i];
    return 105 * tanh(((x / d) * gain) / 2);
  });
}

export interface OscRun {
  side: "ob" | "os"; // ob = above +level, os = below -level
  startT: number; // open time of the first candle of the run
  peak: number; // most extreme value in the run
}

/** The run of candles beyond ±level that the candle at `i` belongs to, if it's beyond. */
export function extremeRun(c: Candle[], osc: number[], level: number, i = osc.length - 1): OscRun | null {
  const v = osc[i];
  const side = v > level ? "ob" : v < -level ? "os" : null;
  if (!side) return null;
  const beyond = (x: number) => (side === "ob" ? x > level : x < -level);
  let j = i;
  let peak = v;
  while (j > 0 && beyond(osc[j - 1])) {
    j--;
    peak = side === "ob" ? Math.max(peak, osc[j]) : Math.min(peak, osc[j]);
  }
  return { side, startT: c[j].t, peak };
}
