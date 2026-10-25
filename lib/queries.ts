import type postgres from "postgres";
import { GOLD_WINDOW_DAYS } from "./signals";

export interface SignalFilter {
  symbol?: string;
  codes?: string[];
  tfs?: string[];
  source?: string;
  direction?: string;
  sinceHours?: number;
  latestOnly?: boolean; // only signals seen in the newest upload of each screener
  limit?: number;
}

export async function listSignals(sql: postgres.Sql, f: SignalFilter) {
  const conds: postgres.PendingQuery<postgres.Row[]>[] = [];
  if (f.symbol) conds.push(sql`symbol ILIKE ${"%" + f.symbol + "%"}`);
  if (f.codes?.length) conds.push(sql`code IN ${sql(f.codes)}`);
  if (f.tfs?.length) conds.push(sql`tf IN ${sql(f.tfs)}`);
  if (f.source) conds.push(sql`source = ${f.source}`);
  if (f.direction) conds.push(sql`direction = ${f.direction}`);
  if (f.sinceHours) conds.push(sql`signal_time >= now() - make_interval(hours => ${f.sinceHours})`);
  if (f.latestOnly) {
    conds.push(sql`id IN (
      SELECT signal_id FROM sightings WHERE upload_id IN (
        SELECT DISTINCT ON (source) id FROM uploads ORDER BY source, created_at DESC))`);
  }
  const where = conds.length ? conds.reduce((a, c) => sql`${a} AND ${c}`) : sql`TRUE`;
  return sql`
    SELECT id, symbol, source, tf, code, family, direction, signal_time, first_seen_at, last_seen_at
    FROM signals WHERE ${where}
    ORDER BY signal_time DESC, symbol
    LIMIT ${Math.min(f.limit ?? 1000, 5000)}`;
}

/** Latest signal per symbol, timeframe and family: the current state of every symbol ever seen. */
export async function symbolBoard(sql: postgres.Sql) {
  return sql`
    SELECT DISTINCT ON (symbol, tf, family) symbol, source, tf, family, code, direction, signal_time, last_seen_at
    FROM signals
    ORDER BY symbol, tf, family, signal_time DESC`;
}

export interface MatchFilter {
  symbol?: string;
  direction?: string;
  goldTfs?: string[];
  sameTfOnly?: boolean;
  status?: string; // confirmed | watching | expired
  sinceDays?: number;
}

/**
 * Every Gold Buy / Gold Sell with the same-direction BOS/CHoCH signals that printed on the same symbol
 * after it and within its timeframe's window.
 */
export interface GoldMatch {
  id: number;
  symbol: string;
  tf: string;
  code: string;
  direction: string;
  signal_time: Date;
  window_end: Date;
  last_seen_at: Date;
  confirmations: Array<{ id: number; tf: string; code: string; signal_time: string; first_seen_at: string }>;
  status: "confirmed" | "watching" | "expired";
}

export async function goldMatches(sql: postgres.Sql, f: MatchFilter): Promise<GoldMatch[]> {
  const windowCase = sql.unsafe(
    "CASE g.tf " +
      Object.entries(GOLD_WINDOW_DAYS).map(([tf, d]) => `WHEN '${tf}' THEN interval '${d} days'`).join(" ") +
      " END",
  );
  const conds: postgres.PendingQuery<postgres.Row[]>[] = [sql`g.family = 'gold'`, sql`g.tf IN ${sql(Object.keys(GOLD_WINDOW_DAYS))}`];
  if (f.symbol) conds.push(sql`g.symbol ILIKE ${"%" + f.symbol + "%"}`);
  if (f.direction) conds.push(sql`g.direction = ${f.direction}`);
  if (f.goldTfs?.length) conds.push(sql`g.tf IN ${sql(f.goldTfs)}`);
  if (f.sinceDays) conds.push(sql`g.signal_time >= now() - make_interval(days => ${f.sinceDays})`);
  const where = conds.reduce((a, c) => sql`${a} AND ${c}`);
  const sameTf = f.sameTfOnly ? sql`AND s.tf = g.tf` : sql``;

  const rows = await sql<Omit<GoldMatch, "status">[]>`
    WITH gold AS (
      SELECT g.*, g.signal_time + ${windowCase} AS window_end FROM signals g WHERE ${where}
    )
    SELECT g.id, g.symbol, g.tf, g.code, g.direction, g.signal_time, g.window_end, g.last_seen_at,
      COALESCE(json_agg(json_build_object(
        'id', s.id, 'tf', s.tf, 'code', s.code, 'signal_time', s.signal_time, 'first_seen_at', s.first_seen_at
      ) ORDER BY s.signal_time) FILTER (WHERE s.id IS NOT NULL), '[]') AS confirmations
    FROM gold g
    LEFT JOIN signals s ON s.symbol = g.symbol AND s.source = 'structure' AND s.direction = g.direction
      AND s.signal_time > g.signal_time AND s.signal_time <= g.window_end ${sameTf}
    GROUP BY g.id, g.symbol, g.tf, g.code, g.direction, g.signal_time, g.window_end, g.last_seen_at
    ORDER BY g.signal_time DESC`;

  const now = Date.now();
  const out: GoldMatch[] = rows.map((r) => ({
    ...r,
    status: r.confirmations.length ? "confirmed" : new Date(r.window_end).getTime() > now ? "watching" : "expired",
  }));
  return f.status ? out.filter((r) => r.status === f.status) : out;
}

export async function listUploads(sql: postgres.Sql, limit = 100) {
  return sql`
    SELECT id, filename, source, captured_at, created_at, tz_offset_min, signal_count, new_count, warnings
    FROM uploads ORDER BY created_at DESC LIMIT ${limit}`;
}
