// Signal vocabulary, timeframe rules, and parsing of raw screener cell text.

export type Source = "divergence" | "structure";
export type Direction = "bull" | "bear";

export interface SignalDef {
  code: string;
  label: string; // label exactly as the screener prints it
  name: string;
  source: Source;
  family: "gold" | "vmc" | "rsi" | "bos" | "choch";
  direction: Direction;
}

export const SIGNALS: SignalDef[] = [
  { code: "GOLD_BUY", label: "G🔥", name: "Gold Buy", source: "divergence", family: "gold", direction: "bull" },
  { code: "GOLD_SELL", label: "G❄", name: "Gold Sell", source: "divergence", family: "gold", direction: "bear" },
  { code: "VMC_BULL", label: "V↑", name: "VMC Bull Div", source: "divergence", family: "vmc", direction: "bull" },
  { code: "VMC_BEAR", label: "V↓", name: "VMC Bear Div", source: "divergence", family: "vmc", direction: "bear" },
  { code: "RSI_BULL", label: "R↑", name: "RSI Bull Div", source: "divergence", family: "rsi", direction: "bull" },
  { code: "RSI_BEAR", label: "R↓", name: "RSI Bear Div", source: "divergence", family: "rsi", direction: "bear" },
  { code: "INT_BOS_BULL", label: "Int BOS↑", name: "Bullish Internal BOS", source: "structure", family: "bos", direction: "bull" },
  { code: "INT_BOS_BEAR", label: "Int BOS↓", name: "Bearish Internal BOS", source: "structure", family: "bos", direction: "bear" },
  { code: "SW_BOS_BULL", label: "Sw BOS↑", name: "Bullish Swing BOS", source: "structure", family: "bos", direction: "bull" },
  { code: "SW_BOS_BEAR", label: "Sw BOS↓", name: "Bearish Swing BOS", source: "structure", family: "bos", direction: "bear" },
  { code: "INT_CHOCH_BULL", label: "Int CHoCH↑", name: "Bullish Internal CHoCH", source: "structure", family: "choch", direction: "bull" },
  { code: "INT_CHOCH_BEAR", label: "Int CHoCH↓", name: "Bearish Internal CHoCH", source: "structure", family: "choch", direction: "bear" },
  { code: "SW_CHOCH_BULL", label: "Sw CHoCH↑", name: "Bullish Swing CHoCH", source: "structure", family: "choch", direction: "bull" },
  { code: "SW_CHOCH_BEAR", label: "Sw CHoCH↓", name: "Bearish Swing CHoCH", source: "structure", family: "choch", direction: "bear" },
];

export const SIGNAL_BY_CODE = Object.fromEntries(SIGNALS.map((s) => [s.code, s])) as Record<string, SignalDef>;

// How long after a Gold signal we keep looking for same-direction BOS/CHoCH, by the Gold signal's timeframe.
export const GOLD_WINDOW_DAYS: Record<string, number> = { "15m": 2, "1h": 7, "4h": 14, "1D": 21 };

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "15", "15m", "15M" -> "15m"; "60", "1h", "1H" -> "1h"; "240", "4h" -> "4h"; "D", "1D" -> "1D". */
export function normalizeTf(raw: string): string {
  const t = raw.trim().replace(/\s+/g, "");
  let m = t.match(/^(\d+)$/); // TradingView minutes notation
  if (m) {
    const n = parseInt(m[1], 10);
    return n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  if ((m = t.match(/^(\d+)(?:m|min)$/))) return `${parseInt(m[1], 10)}m`; // lowercase m = minutes
  if ((m = t.match(/^(\d+)h$/i))) return `${parseInt(m[1], 10)}h`;
  if ((m = t.match(/^(\d*)D$/i))) return `${m[1] || "1"}D`;
  if ((m = t.match(/^(\d*)W$/i))) return `${m[1] || "1"}W`;
  if ((m = t.match(/^(\d*)M$/))) return `${m[1] || "1"}M`; // uppercase M = months
  return t;
}

/** "BITGET:BTCUSDT.P" / "btcusdt.p" -> "BTCUSDT.P" */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, "");
  return s.includes(":") ? s.split(":").pop()! : s;
}

/** "+05:30" / "UTC+5:30" / "+0530" -> minutes east of UTC. */
export function parseOffset(raw: string): number {
  const m = raw.replace(/UTC|GMT/i, "").trim().match(/^([+-])?(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return 0;
  const mins = parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
  return m[1] === "-" ? -mins : mins;
}

/** Reads TradingView's snapshot header, e.g. "created with TradingView.com, Oct 25, 2026 16:00 UTC+5:30". */
export function parseCaptureHeader(text: string): Date | null {
  const m = text.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(?:UTC|GMT)?\s*([+-]\d{1,2}(?::?\d{2})?)?/);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const offset = m[6] ? parseOffset(m[6]) : 0;
  const utc = Date.UTC(+m[3], mon, +m[2], +m[4], +m[5]) - offset * 60_000;
  return new Date(utc);
}

/**
 * Parses a cell timestamp printed without a year ("25 Oct 15:15", "10/25 15:15", "2026-10-25 15:15")
 * in the given UTC offset. The year comes from the capture time: a date that would land more than a day
 * after the capture belongs to the previous year.
 */
export function parseCellTime(text: string, offsetMin: number, capturedAt: Date): Date | null {
  const t = text.trim();
  let year: number | null = null, mon: number | undefined, day: number, hh: number, mm: number;
  let m = t.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/); // 25 Oct 15:15 / 25-Oct 15:15
  if (m) {
    day = +m[1]; mon = MONTHS[m[2].toLowerCase()]; hh = +m[3]; mm = +m[4];
  } else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/))) {
    year = +m[1]; mon = +m[2] - 1; day = +m[3]; hh = +m[4]; mm = +m[5];
  } else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/))) {
    // MM/dd is the default of both scripts' slash formats
    mon = +m[1] - 1; day = +m[2]; hh = +m[3]; mm = +m[4];
  } else {
    return null;
  }
  if (mon === undefined || mon < 0 || mon > 11 || day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  const build = (y: number) => new Date(Date.UTC(y, mon!, day, hh, mm) - offsetMin * 60_000);
  if (year !== null) return build(year);
  const capYear = new Date(capturedAt.getTime() + offsetMin * 60_000).getUTCFullYear();
  let d = build(capYear);
  if (d.getTime() > capturedAt.getTime() + 36 * 3600_000) d = build(capYear - 1);
  return d;
}

export interface ParsedSignal {
  code: string;
  time: Date;
  recentBadge: boolean;
  raw: string;
}

// Longest labels first so "Int BOS↑" wins over shorter matches. Compact labels (iBOS↑, sCHoCH↓) map too.
const LABEL_PATTERNS: Array<{ re: RegExp; code: string }> = [
  { re: /^(?:Int\s*BOS|iBOS)\s*↑/i, code: "INT_BOS_BULL" },
  { re: /^(?:Int\s*BOS|iBOS)\s*↓/i, code: "INT_BOS_BEAR" },
  { re: /^(?:Sw\s*BOS|sBOS)\s*↑/i, code: "SW_BOS_BULL" },
  { re: /^(?:Sw\s*BOS|sBOS)\s*↓/i, code: "SW_BOS_BEAR" },
  { re: /^(?:Int\s*CHoCH|iCHoCH)\s*↑/i, code: "INT_CHOCH_BULL" },
  { re: /^(?:Int\s*CHoCH|iCHoCH)\s*↓/i, code: "INT_CHOCH_BEAR" },
  { re: /^(?:Sw\s*CHoCH|sCHoCH)\s*↑/i, code: "SW_CHOCH_BULL" },
  { re: /^(?:Sw\s*CHoCH|sCHoCH)\s*↓/i, code: "SW_CHOCH_BEAR" },
  { re: /^G\s*🔥/u, code: "GOLD_BUY" },
  { re: /^G\s*❄️?/u, code: "GOLD_SELL" },
  { re: /^V\s*↑/, code: "VMC_BULL" },
  { re: /^V\s*↓/, code: "VMC_BEAR" },
  { re: /^R\s*↑/, code: "RSI_BULL" },
  { re: /^R\s*↓/, code: "RSI_BEAR" },
];

const BADGE_RE = /^[⚡★🔥●]️?\s*|^NEW\s+/u;

/**
 * Parses one screener cell. Lines may be split by newline or " | ". The structure screener's two-line
 * layout puts the label and the time on separate lines, so a line holding only a time is joined to the
 * label line before it.
 */
export function parseCell(lines: string[], offsetMin: number, capturedAt: Date): { signals: ParsedSignal[]; unparsed: string[] } {
  const flat = lines.flatMap((l) => l.split(/\s*\|\s*|\n/)).map((l) => l.trim()).filter((l) => l && l !== "-");
  const merged: string[] = [];
  for (const line of flat) {
    const isTimeOnly = /^(\d{1,2}[\s-]+[A-Za-z]{3}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\s+\d{1,2}:\d{2}$/.test(line);
    if (isTimeOnly && merged.length) merged[merged.length - 1] += " " + line;
    else merged.push(line);
  }
  const signals: ParsedSignal[] = [];
  const unparsed: string[] = [];
  for (const line of merged) {
    let rest = line;
    let recentBadge = false;
    // A bare "🔥" badge would be ambiguous with Gold Buy, but the Gold label always starts with "G".
    while (BADGE_RE.test(rest) && !/^G\s*🔥/u.test(rest)) {
      recentBadge = true;
      rest = rest.replace(BADGE_RE, "");
    }
    const pat = LABEL_PATTERNS.find((p) => p.re.test(rest));
    if (!pat) { unparsed.push(line); continue; }
    const timeText = rest.replace(pat.re, "").trim();
    const time = parseCellTime(timeText, offsetMin, capturedAt);
    if (!time) { unparsed.push(line); continue; }
    signals.push({ code: pat.code, time, recentBadge, raw: line });
  }
  return { signals, unparsed };
}
