// Unit checks for cell parsing and timezone/year handling, using transcriptions of the sample screenshots.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flatten } from "../lib/ingest";
import { normalizeTf, parseCaptureHeader, parseCell, parseCellTime } from "../lib/signals";

const IST = 330;
const cap = parseCaptureHeader("x created with TradingView.com, Oct 25, 2026 16:00 UTC+5:30")!;
assert.equal(cap.toISOString(), "2026-10-25T10:30:00.000Z");

assert.equal(parseCellTime("25 Oct 15:15", IST, cap)!.toISOString(), "2026-10-25T09:45:00.000Z");
// November is after the capture date, so it belongs to the previous year
assert.equal(parseCellTime("25 Nov 05:30", IST, cap)!.toISOString(), "2025-11-25T00:00:00.000Z");
assert.equal(parseCellTime("25 Oct 08:15", 0, cap)!.toISOString(), "2026-10-25T08:15:00.000Z");
assert.equal(parseCellTime("25-Oct 08:15", 0, cap)!.toISOString(), "2026-10-25T08:15:00.000Z");
assert.equal(parseCellTime("10/25 08:15", 0, cap)!.toISOString(), "2026-10-25T08:15:00.000Z");

for (const [i, o] of [["15", "15m"], ["15m", "15m"], ["60", "1h"], ["1h", "1h"], ["240", "4h"], ["4H", "4h"], ["1D", "1D"], ["D", "1D"], ["480", "8h"]]) {
  assert.equal(normalizeTf(i), o, i);
}

let c = parseCell(["⚡ G🔥 25 Oct 15:15", "⚡ V↑ 25 Oct 15:15", "R↑ 24 Oct 22:00"], IST, cap);
assert.deepEqual(c.signals.map((s) => [s.code, s.recentBadge]), [["GOLD_BUY", true], ["VMC_BULL", true], ["RSI_BULL", false]]);
c = parseCell(["G❄ 23 Sep 02:30 | V↓ 03 Oct 01:30"], IST, cap);
assert.deepEqual(c.signals.map((s) => s.code), ["GOLD_SELL", "VMC_BEAR"]);
c = parseCell(["G❄️ 23 Sep 02:30"], IST, cap); // emoji variation selector
assert.deepEqual(c.signals.map((s) => s.code), ["GOLD_SELL"]);
c = parseCell(["⚡ Int CHoCH↑", "25 Oct 10:00"], 0, cap);
assert.deepEqual(c.signals.map((s) => [s.code, s.time.toISOString(), s.recentBadge]), [["INT_CHOCH_BULL", "2026-10-25T10:00:00.000Z", true]]);
c = parseCell(["⚡ sBOS↓ 25 Oct 10:00"], 0, cap);
assert.deepEqual(c.signals.map((s) => s.code), ["SW_BOS_BEAR"]);
c = parseCell(["-"], 0, cap);
assert.equal(c.signals.length + c.unparsed.length, 0);
c = parseCell(["Q↑ 25 Oct 10:00"], 0, cap);
assert.equal(c.unparsed.length, 1);

const offsets = { divergence: IST, structure: 0 };
const div = flatten(JSON.parse(readFileSync("scripts/fixtures/divergence.json", "utf8")), offsets, new Date());
assert.equal(div.source, "divergence");
assert.deepEqual(div.warnings, []);
assert.equal(div.signals.length, 5 * 12 - 1); // JUP 1D has no Gold line
const bos = flatten(JSON.parse(readFileSync("scripts/fixtures/structure.json", "utf8")), offsets, new Date());
assert.equal(bos.source, "structure");
assert.deepEqual(bos.warnings, []);
assert.equal(bos.signals.length, 15);

// Wrong timezone shows up as a warning: BOS times read as IST would still be fine, but divergence read as UTC lands in the future
const wrong = flatten(JSON.parse(readFileSync("scripts/fixtures/divergence.json", "utf8")), { divergence: 0, structure: 0 }, new Date());
assert.ok(wrong.warnings.some((w) => w.includes("timezone")));

console.log("parse tests passed");
