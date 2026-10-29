// Telegram alerts. The bot token stays in the TELEGRAM_BOT_TOKEN environment variable; the chat id comes from
// TELEGRAM_CHAT_ID, or is found from the first message sent to the bot and saved in the settings table.
import type postgres from "postgres";

export interface AlertSettings {
  gold: boolean; // every new Gold signal
  goldStructure: boolean; // Gold followed by same-direction BOS/CHoCH
  fibTouch: boolean; // Gold, then price at a matching fib
  fibStructure: boolean; // Gold, fib touch, then BOS/CHoCH
  trendChange: boolean; // a timeframe's trend flips
  trendPotential: boolean; // higher high in a downtrend / lower low in an uptrend
  trendTfs: string[];
  fibTolerancePct: number; // how close counts as touching a fib level
  captureHealth: boolean; // the hourly capture failed, came back short, or stopped uploading
  captureStaleMinutes: number;
}

export const DEFAULT_SETTINGS: AlertSettings = {
  gold: false,
  goldStructure: true,
  fibTouch: true,
  fibStructure: true,
  trendChange: true,
  trendPotential: true,
  trendTfs: ["1h", "4h", "1D"],
  fibTolerancePct: 0.15,
  captureHealth: true,
  captureStaleMinutes: 90,
};

export async function getSetting<T>(sql: postgres.Sql, key: string): Promise<T | null> {
  const [row] = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return row ? (row.value as T) : null;
}

export async function setSetting(sql: postgres.Sql, key: string, value: unknown) {
  await sql`
    INSERT INTO settings (key, value) VALUES (${key}, ${sql.json(value as postgres.JSONValue)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

export async function alertSettings(sql: postgres.Sql): Promise<AlertSettings> {
  return { ...DEFAULT_SETTINGS, ...((await getSetting<Partial<AlertSettings>>(sql, "alerts")) ?? {}) };
}

const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim();

async function api<T>(method: string, body?: unknown): Promise<T> {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set in Vercel.");
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
  if (!json?.ok) throw new Error(`Telegram ${method}: ${json?.description ?? `HTTP ${res.status}`}`);
  return json.result as T;
}

export async function chatId(sql: postgres.Sql): Promise<string | null> {
  return process.env.TELEGRAM_CHAT_ID?.trim() || (await getSetting<string>(sql, "telegram_chat_id"));
}

/** Looks through the bot's recent messages for the chat that wrote to it, and saves that chat. */
export async function discoverChat(sql: postgres.Sql): Promise<{ id: string; name: string } | null> {
  const updates = await api<Array<{ message?: { chat: { id: number; title?: string; first_name?: string; username?: string } } }>>("getUpdates", {
    allowed_updates: ["message"],
  });
  const chat = updates.map((u) => u.message?.chat).filter(Boolean).pop();
  if (!chat) return null;
  await setSetting(sql, "telegram_chat_id", String(chat.id));
  return { id: String(chat.id), name: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id) };
}

export async function telegramStatus(sql: postgres.Sql) {
  const configured = !!token();
  let bot: string | null = null, error: string | null = null;
  if (configured) {
    try {
      bot = (await api<{ username: string }>("getMe")).username;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { configured, bot, chatId: await chatId(sql), chatFromEnv: !!process.env.TELEGRAM_CHAT_ID, error };
}

export async function sendTelegram(sql: postgres.Sql, html: string) {
  const id = await chatId(sql);
  if (!id) throw new Error("No Telegram chat yet. Send your bot a message, then press Find my chat on the Alerts tab.");
  await api("sendMessage", { chat_id: id, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

export function telegramReady() {
  return !!token();
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
