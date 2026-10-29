import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fibSignals } from "@/lib/queries";
import { fail, num } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    return NextResponse.json(await fibSignals(await db(), num(q.get("sinceDays")) ?? 14));
  } catch (e) {
    return fail(e);
  }
}
