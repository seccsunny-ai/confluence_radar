import { NextResponse } from "next/server";
import { recentCandles } from "@/lib/market";
import { swingStructure } from "@/lib/structure";
import { legFibs } from "@/lib/autofib";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 60;
// Temporary: SOL swing structure, to compare with the user's example fibs.
export async function GET() {
  const out: Record<string, unknown> = {};
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
  for (const tf of ["30m", "1h", "2h", "4h"]) {
    const c = (await recentCandles("SOLUSDT.P", tf, 1000)).slice(0, -1);
    const st = swingStructure(c);
    out[tf] = {
      n: c.length, from: iso(c[0].t), trend: st.trend,
      highs: st.highs.slice(-6).map((p) => `${p.price} ${iso(p.t)}`),
      lows: st.lows.slice(-6).map((p) => `${p.price} ${iso(p.t)}`),
      breaks: st.breaks.slice(-6).map((b) => `${b.kind} ${b.direction} ${b.level.price} ${iso(b.t)}`),
      fibs: legFibs(c, st).map((f) => `${f.direction} ${f.low}-${f.high} ${f.forming ? "forming" : ""}`),
    };
  }
  return NextResponse.json(out);
}
