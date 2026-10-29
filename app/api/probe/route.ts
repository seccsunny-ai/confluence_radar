import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 60;
// Temporary: how far back Bitget's candle endpoints go.
export async function GET() {
  const B = "https://api.bitget.com/api/v2/mix/market/";
  const q = "symbol=BTCUSDT&productType=USDT-FUTURES";
  const get = async (u: string) => {
    const j = await (await fetch(B + u, { cache: "no-store" })).json();
    const d: string[][] = j.data ?? [];
    return { u, code: j.code, msg: j.msg, n: d.length, first: d[0]?.[0] && new Date(+d[0][0]).toISOString(), last: d.at(-1)?.[0] && new Date(+d.at(-1)![0]).toISOString() };
  };
  const out = [];
  for (const g of ["1H", "2H", "4H", "1Dutc", "1Wutc"]) out.push(await get(`candles?${q}&granularity=${g}&limit=1000`));
  const now = Date.now();
  for (const [g, back] of [["1Dutc", 100 * 864e5], ["1Wutc", 100 * 864e5], ["1Dutc", 2000 * 864e5], ["1Wutc", 3000 * 864e5], ["4H", 200 * 864e5]] as const) {
    out.push(await get(`history-candles?${q}&granularity=${g}&limit=200&endTime=${now - back}`));
  }
  out.push(await get(`history-candles?${q}&granularity=1Wutc&limit=200&startTime=${now - 3000 * 864e5}&endTime=${now - 100 * 864e5}`));
  out.push(await get(`history-candles?${q}&granularity=1Dutc&limit=1000&endTime=${now - 100 * 864e5}`));
  return NextResponse.json(out);
}
