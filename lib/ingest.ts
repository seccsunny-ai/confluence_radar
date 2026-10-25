import type postgres from "postgres";
import type { ScreenshotData } from "./extract";
import { normalizeSymbol, normalizeTf, parseCaptureHeader, parseCell, SIGNAL_BY_CODE, type Source } from "./signals";

export interface FlatSignal {
  symbol: string;
  tf: string;
  code: string;
  time: Date;
  recentBadge: boolean;
}

export interface Flattened {
  source: Source;
  capturedAt: Date;
  capturedFromHeader: boolean;
  signals: FlatSignal[];
  warnings: string[];
}

/** Turns the transcribed tables into individual signals with absolute UTC times. */
export function flatten(
  data: ScreenshotData,
  offsets: Record<Source, number>,
  fallbackCapture: Date,
  fallbackIsExact = false, // true when the uploader sent the capture time (automated screenshots have no header)
): Flattened {
  const warnings: string[] = [];
  const header = parseCaptureHeader(data.header_text);
  const capturedAt = header ?? fallbackCapture;
  if (!header && !fallbackIsExact) warnings.push(`Could not read the snapshot time from "${data.header_text}", so the upload time was used.`);

  // Trust the labels over the model's classification when they disagree.
  const allLines = data.tables.flatMap((t) => t.rows.flatMap((r) => r.cells.flat())).join(" ");
  const looksStructure = /BOS|CHoCH/i.test(allLines);
  const looksDivergence = /G\s*🔥|G\s*❄|[VR]\s*[↑↓]/u.test(allLines);
  let source: Source;
  if (looksStructure && !looksDivergence) source = "structure";
  else if (looksDivergence && !looksStructure) source = "divergence";
  else if (data.screener === "unknown") throw new Error("Could not tell which screener this screenshot shows.");
  else source = data.screener;

  const offset = offsets[source];
  const seen = new Set<string>();
  const signals: FlatSignal[] = [];
  for (const table of data.tables) {
    const tfs = table.timeframes.map(normalizeTf);
    for (const row of table.rows) {
      const symbol = normalizeSymbol(row.symbol);
      if (!symbol || symbol === "SYMBOL") continue;
      if (row.cells.length !== tfs.length) warnings.push(`${symbol}: ${row.cells.length} cells for ${tfs.length} timeframes.`);
      row.cells.slice(0, tfs.length).forEach((cell, i) => {
        const { signals: parsed, unparsed } = parseCell(cell, offset, capturedAt);
        for (const u of unparsed) warnings.push(`${symbol} ${tfs[i]}: could not read "${u}".`);
        for (const p of parsed) {
          if (SIGNAL_BY_CODE[p.code].source !== source) {
            warnings.push(`${symbol} ${tfs[i]}: "${p.raw}" does not belong on the ${source} screener, skipped.`);
            continue;
          }
          if (p.time.getTime() > capturedAt.getTime() + 60 * 60_000) {
            warnings.push(`${symbol} ${tfs[i]}: "${p.raw}" is later than the snapshot time. Check the ${source} timezone setting.`);
          }
          const key = `${symbol}|${tfs[i]}|${p.code}|${p.time.getTime()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          signals.push({ symbol, tf: tfs[i], code: p.code, time: p.time, recentBadge: p.recentBadge });
        }
      });
    }
  }
  return { source, capturedAt, capturedFromHeader: !!header, signals, warnings };
}

export async function store(
  sql: postgres.Sql,
  flat: Flattened,
  raw: ScreenshotData,
  filename: string | null,
  offsetMin: number,
): Promise<{ uploadId: number; newCount: number; duplicateUpload: boolean }> {
  return sql.begin(async (tx) => {
    const [upload] = await tx`
      INSERT INTO uploads (filename, source, captured_at, tz_offset_min, signal_count, warnings, raw)
      VALUES (${filename}, ${flat.source}, ${flat.capturedAt}, ${offsetMin}, ${flat.signals.length},
              ${tx.json(flat.warnings)}, ${tx.json(raw as unknown as postgres.JSONValue)})
      RETURNING id`;
    let newCount = 0;
    for (const s of flat.signals) {
      const def = SIGNAL_BY_CODE[s.code];
      const [row] = await tx`
        INSERT INTO signals (symbol, source, tf, code, family, direction, signal_time, first_seen_at, last_seen_at)
        VALUES (${s.symbol}, ${def.source}, ${s.tf}, ${s.code}, ${def.family}, ${def.direction}, ${s.time},
                ${flat.capturedAt}, ${flat.capturedAt})
        ON CONFLICT (symbol, tf, code, signal_time) DO UPDATE SET
          first_seen_at = LEAST(signals.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at  = GREATEST(signals.last_seen_at, EXCLUDED.last_seen_at)
        RETURNING id, (xmax = 0) AS inserted`;
      if (row.inserted) newCount++;
      await tx`
        INSERT INTO sightings (upload_id, signal_id, recent_badge) VALUES (${upload.id}, ${row.id}, ${s.recentBadge})
        ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE uploads SET new_count = ${newCount} WHERE id = ${upload.id}`;
    const dup = await tx`
      SELECT 1 FROM uploads WHERE id <> ${upload.id} AND source = ${flat.source} AND captured_at = ${flat.capturedAt} LIMIT 1`;
    return { uploadId: upload.id as number, newCount, duplicateUpload: dup.length > 0 && flat.capturedFromHeader };
  });
}

/** Removes an upload and any signal that no other upload has seen. */
export async function deleteUpload(sql: postgres.Sql, id: number) {
  await sql.begin(async (tx) => {
    const ids = await tx`SELECT signal_id FROM sightings WHERE upload_id = ${id}`;
    await tx`DELETE FROM uploads WHERE id = ${id}`;
    if (ids.length) {
      await tx`
        DELETE FROM signals s WHERE s.id IN ${tx(ids.map((r) => r.signal_id as number))}
          AND NOT EXISTS (SELECT 1 FROM sightings g WHERE g.signal_id = s.id)`;
    }
  });
}
