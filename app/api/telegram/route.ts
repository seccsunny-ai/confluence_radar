import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { alertSettings, DEFAULT_SETTINGS, discoverChat, sendTelegram, setSetting, telegramStatus, type AlertSettings } from "@/lib/telegram";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sql = await db();
    const [status, settings, recent] = await Promise.all([
      telegramStatus(sql),
      alertSettings(sql),
      sql`SELECT key, text, sent_at FROM alerts WHERE text <> '' ORDER BY sent_at DESC LIMIT 30`,
    ]);
    return NextResponse.json({ status, settings, recent });
  } catch (e) {
    return fail(e);
  }
}

/** Body: {"action": "discover"} | {"action": "test"} | {"action": "settings", "settings": {...}} */
export async function POST(req: Request) {
  try {
    const sql = await db();
    const body = (await req.json()) as { action?: string; settings?: Partial<AlertSettings> };
    if (body.action === "discover") {
      const chat = await discoverChat(sql);
      if (!chat) return fail("The bot has no messages yet. Open your bot in Telegram, press Start or send it any message, then try again.", 400);
      return NextResponse.json(chat);
    }
    if (body.action === "test") {
      await sendTelegram(sql, "✅ Confluence Radar is connected. Signals will arrive here.");
      return NextResponse.json({ ok: true });
    }
    if (body.action === "settings" && body.settings) {
      const s = { ...(await alertSettings(sql)) } as AlertSettings;
      for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof AlertSettings>) {
        if (body.settings[k] !== undefined && typeof body.settings[k] === typeof DEFAULT_SETTINGS[k]) {
          (s as unknown as Record<string, unknown>)[k] = body.settings[k];
        }
      }
      s.fibTolerancePct = Math.min(Math.max(s.fibTolerancePct, 0), 5);
      await setSetting(sql, "alerts", s);
      return NextResponse.json(s);
    }
    return fail("Unknown action.", 400);
  } catch (e) {
    return fail(e, 400);
  }
}
