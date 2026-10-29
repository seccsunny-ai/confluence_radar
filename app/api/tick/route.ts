import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tick } from "@/lib/radar";
import { fail } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
// Bitget's API refuses some US addresses, so this runs from Singapore rather than Vercel's default US region.
export const preferredRegion = "sin1";

/** Runs the check: trends, fib touches, BOS/CHoCH after them, Telegram alerts. Called every 15 minutes and after uploads. */
export async function POST() {
  try {
    return NextResponse.json(await tick(await db()));
  } catch (e) {
    return fail(e);
  }
}

/** The last few runs. */
export async function GET() {
  try {
    const sql = await db();
    return NextResponse.json(await sql`SELECT started_at, summary FROM ticks ORDER BY id DESC LIMIT 10`);
  } catch (e) {
    return fail(e);
  }
}
