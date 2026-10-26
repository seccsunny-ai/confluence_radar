// Parses the plain-text upload format: one signal per line, no AI needed.
//
//   CAPTURED: 2026-10-25 16:00 +05:30        optional, when the screenshot was taken
//   TZ: +05:30                               optional, timezone of the times on the lines below it
//   SYMBOL, TIMEFRAME, SIGNAL, TIME          optional header line
//   BTCUSDT.P, 15m, G🔥, 22 Oct 15:15
//   BTCUSDT.P, 1h, Int BOS↓, 24 Oct 14:00
//
// Separators may be commas, "|" or tabs. SIGNAL may be the screener label (G🔥, Int BOS↓), the code (GOLD_BUY)
// or the name (Gold Buy), with an optional leading ⚡.
import type { Flattened, FlatSignal } from "./ingest";
import { normalizeSymbol, normalizeTf, parseCaptureHeader, parseCell, parseOffset, SIGNALS, type Source } from "./signals";

const ALIASES = new Map<string, string>();
for (const s of SIGNALS) {
  for (const k of [s.code, s.name, s.code.replace(/_/g, " ")]) ALIASES.set(k.toLowerCase(), s.label);
}
ALIASES.set("gold sell", "G❄");
ALIASES.set("gold buy", "G🔥");

function parseCaptured(v: string): Date | null {
  const tv = parseCaptureHeader(v);
  if (tv) return tv;
  const m = v.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*(?:UTC|GMT)?\s*([+-]\d{1,2}(?::?\d{2})?)?/i);
  if (!m) return null;
  const offset = m[6] ? parseOffset(m[6]) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offset * 60_000);
}

export function parseTextUpload(text: string, defaultOffsets: Record<Source, number>, now = new Date()): Flattened[] {
  let capturedAt = null as Date | null;
  let tz = null as number | null;
  const warnings: string[] = [];
  const pending: Array<{ line: number; symbol: string; tf: string; signal: string; time: string; tz: number | null }> = [];

  text.split(/\r?\n/).forEach((rawLine, i) => {
    // Text copied from TradingView's Pine Logs starts each entry with its timestamp, e.g. "[2026-10-26T07:00:00.000+00:00]: ".
    const line = rawLine.trim().replace(/^\[?\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s*:?\s*/, "");
    if (!line || line.startsWith("#") || line.startsWith("```")) return;
    const kv = line.match(/^(CAPTURED|TZ|TIMEZONE)\s*[:=]\s*(.+)$/i);
    if (kv) {
      if (/^CAPTURED$/i.test(kv[1])) {
        capturedAt = parseCaptured(kv[2]);
        if (!capturedAt) warnings.push(`Line ${i + 1}: could not read the time "${kv[2]}".`);
      } else {
        tz = parseOffset(kv[2].trim());
      }
      return;
    }
    const parts = line.split(/\s*[,|\t]\s*/).filter(Boolean);
    if (/^symbol$/i.test(parts[0] ?? "")) return; // header line
    if (parts.length < 4) {
      warnings.push(`Line ${i + 1}: expected "SYMBOL, TIMEFRAME, SIGNAL, TIME" but got "${line}".`);
      return;
    }
    const [symbol, tf, signal] = parts;
    pending.push({ line: i + 1, symbol, tf, signal, time: parts.slice(3).join(" "), tz });
  });

  const cap = capturedAt ?? now;
  const bySource: Record<Source, FlatSignal[]> = { divergence: [], structure: [] };
  const seen = new Set<string>();
  for (const p of pending) {
    const badge = /^⚡/u.test(p.signal);
    const bare = p.signal.replace(/^⚡️?\s*/u, "");
    const label = ALIASES.get(bare.toLowerCase()) ?? bare;
    // Try the line's timezone, or each screener's default until the signal's screener is known.
    const probe = parseCell([`${label} ${p.time}`], 0, cap).signals[0];
    if (!probe) {
      warnings.push(`Line ${p.line}: could not read signal "${p.signal}" with time "${p.time}".`);
      continue;
    }
    const source = SIGNALS.find((s) => s.code === probe.code)!.source;
    const offset = p.tz ?? defaultOffsets[source];
    const parsed = parseCell([`${label} ${p.time}`], offset, cap).signals[0];
    const symbol = normalizeSymbol(p.symbol);
    const tf = normalizeTf(p.tf);
    if (parsed.time.getTime() > cap.getTime() + 60 * 60_000) {
      warnings.push(`Line ${p.line}: ${symbol} ${tf} ${p.signal} ${p.time} is later than the capture time. Check the timezone.`);
    }
    const key = `${symbol}|${tf}|${parsed.code}|${parsed.time.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bySource[source].push({ symbol, tf, code: parsed.code, time: parsed.time, recentBadge: badge });
  }

  if (!pending.length) throw new Error("No signal lines found. Each line should be: SYMBOL, TIMEFRAME, SIGNAL, TIME");
  if (!bySource.divergence.length && !bySource.structure.length) {
    throw new Error(`None of the lines could be read. ${warnings.slice(0, 3).join(" ")}`);
  }
  return (Object.keys(bySource) as Source[])
    .filter((s) => bySource[s].length)
    .map((source, idx) => ({
      source,
      capturedAt: cap,
      capturedFromHeader: capturedAt !== null,
      signals: bySource[source],
      warnings: idx === 0 ? warnings : [], // report line problems once
    }));
}
