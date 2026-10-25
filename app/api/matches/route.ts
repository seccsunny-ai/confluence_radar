import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { goldMatches } from "@/lib/queries";
import { fail, list, num } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const rows = await goldMatches(await db(), {
      symbol: q.get("symbol") || undefined,
      direction: q.get("direction") || undefined,
      goldTfs: list(q.get("tfs")),
      sameTfOnly: q.get("sameTf") === "1",
      status: q.get("status") || undefined,
      sinceDays: num(q.get("sinceDays")),
    });
    return NextResponse.json(rows);
  } catch (e) {
    return fail(e);
  }
}
