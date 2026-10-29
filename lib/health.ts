// Telegram warnings when the hourly capture misses something: a chart that failed or read far fewer signals
// than usual (reported by capture.mjs), or a screener with no upload for a while (checked by the periodic run).
import type postgres from "postgres";
import { z } from "zod";
import { alertSettings, esc, getSetting, sendTelegram, setSetting, telegramReady } from "./telegram";

export const CaptureReport = z.object({
  charts: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    ok: z.boolean(),
    signals: z.number().int().min(0).default(0),
    error: z.string().max(2000).optional(),
  })).min(1).max(50),
});
export type CaptureReport = z.infer<typeof CaptureReport>;

const HISTORY = 24; // successful counts kept per chart
const SHORT = 0.8; // fewer than this share of the usual count is reported as short

/** Sends `html` once per `key`; returns whether it was sent. */
async function sendOnce(sql: postgres.Sql, key: string, html: string): Promise<boolean> {
  const [row] = await sql`INSERT INTO alerts (key, text) VALUES (${key}, ${html}) ON CONFLICT DO NOTHING RETURNING key`;
  if (!row) return false;
  try {
    await sendTelegram(sql, html);
    return true;
  } catch (e) {
    await sql`DELETE FROM alerts WHERE key = ${key}`;
    throw e;
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Records a capture run and warns about charts that failed or came back short. Returns the problems found. */
export async function captureReport(sql: postgres.Sql, report: CaptureReport, now = new Date()): Promise<string[]> {
  const problems: string[] = [];
  for (const c of report.charts) {
    const key = `capture:${c.name}`;
    const counts = (await getSetting<number[]>(sql, key)) ?? [];
    if (!c.ok) {
      problems.push(`<b>${esc(c.name)}</b> failed: ${esc((c.error ?? "no reason given").slice(0, 300))}`);
      continue;
    }
    const usual = counts.length >= 3 ? median(counts) : null;
    if (usual && c.signals < usual * SHORT) problems.push(`<b>${esc(c.name)}</b> read only ${c.signals} signals (usually ${Math.round(usual)})`);
    else await setSetting(sql, key, [...counts, c.signals].slice(-HISTORY)); // a short read doesn't lower the norm
  }
  await setSetting(sql, "capture_last", { at: now.toISOString(), charts: report.charts });
  if (problems.length && telegramReady() && (await alertSettings(sql)).captureHealth) {
    const hour = now.toISOString().slice(0, 13);
    await sendOnce(sql, `capture-report:${hour}`,
      `🩺 <b>Capture missed something</b>\n${problems.map((p) => `• ${p}`).join("\n")}\nThe next hourly run usually fills it in. Details are in capture.log.`);
  }
  return problems;
}

/** Warns once per gap when a screener has had no upload for `captureStaleMinutes`. */
export async function checkStale(sql: postgres.Sql): Promise<number> {
  const settings = await alertSettings(sql);
  if (!settings.captureHealth || !telegramReady()) return 0;
  const rows = await sql`
    SELECT DISTINCT ON (source) id, source, created_at FROM uploads ORDER BY source, created_at DESC`;
  let sent = 0;
  for (const r of rows) {
    const minutes = (Date.now() - new Date(r.created_at).getTime()) / 60_000;
    if (minutes < settings.captureStaleMinutes) continue;
    const name = r.source === "structure" ? "BOS/CHoCH" : "divergence";
    if (await sendOnce(sql, `stale:${r.source}:${r.id}`,
      `🩺 <b>No ${name} signals for ${Math.floor(minutes / 60)}h ${Math.floor(minutes % 60)}m</b>\n` +
      `The hourly capture hasn't uploaded since then. Is the PC on, awake and logged in?`)) sent++;
  }
  return sent;
}
