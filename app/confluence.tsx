"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fibLevels } from "@/lib/fibs";
import { ago, getJson, Sig } from "./ui";

type Fmt = (s: string) => string;

const TREND_TFS = ["15m", "1h", "4h", "1D"];
const tfLabel = (tf: string) => tf.replace(/h$/, "H");

function price(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "–";
  const abs = Math.abs(p);
  return String(Number(p.toFixed(abs >= 1000 ? 1 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8)));
}

async function send(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

interface Tick { started_at: string; summary: { symbols: number; trendsUpdated: number; fibHits: number; alertsSent: number; errors: string[]; ms: number } }

/** Last background check, with a button to run one now. */
export function CheckBar({ fmt, onDone }: { fmt: Fmt; onDone: () => void }) {
  const [last, setLast] = useState<Tick | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => getJson<Tick[]>("/api/tick").then((t) => setLast(t[0] ?? null)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async () => {
    setBusy(true); setErr("");
    try {
      await send("/api/tick", "POST");
      await load();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row small muted" style={{ marginBottom: 10 }}>
      <span>
        {last
          ? <>Prices last checked {fmt(last.started_at)} ({ago(last.started_at)}): {last.summary.symbols} symbols, {last.summary.alertsSent} alerts sent.</>
          : "Prices haven't been checked yet."}
        {" "}Checked automatically every 15 minutes and after each upload.
      </span>
      <button className="btn small" disabled={busy} onClick={run}>{busy ? "Checking…" : "Check now"}</button>
      {err && <span className="status-err">{err}</span>}
      {last?.summary.errors?.length ? (
        <details><summary className="warn">{last.summary.errors.length} problems</summary>
          {last.summary.errors.map((e, i) => <div key={i} className="warn">{e}</div>)}
        </details>
      ) : null}
    </div>
  );
}

// ─────────────────────────────── Gold → Fib ───────────────────────────────

interface FibSignal {
  gold_id: number; symbol: string; tf: string; code: string; direction: string; signal_time: string; window_end: string;
  fib_id: number; fib_tf: string; high: number; low: number; note: string | null; active: boolean;
  ratio: number | null; level: number | null; touched_at: string | null; at_signal: boolean | null;
  structure_id: number | null; structure_tf: string | null; structure_code: string | null; structure_time: string | null;
  status: "stronger" | "touched" | "waiting" | "expired";
}

const STATUS_LABEL: Record<FibSignal["status"], string> = {
  stronger: "Fib + BOS/CHoCH",
  touched: "At fib",
  waiting: "Waiting for fib",
  expired: "Expired",
};

export function FibSignals({ fmt, refresh }: { fmt: Fmt; refresh: number }) {
  const [rows, setRows] = useState<FibSignal[] | null>(null);
  const [status, setStatus] = useState("");
  const [days, setDays] = useState("14");
  const [symbol, setSymbol] = useState("");
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    getJson<FibSignal[]>(`/api/fib-signals?sinceDays=${days}`).then((r) => { setRows(r); setErr(""); }).catch((e) => setErr(e.message));
  }, [days, refresh, n]);
  const shown = useMemo(() => rows?.filter((r) => (!status || r.status === status) && (!symbol || r.symbol.includes(symbol.toUpperCase()))), [rows, status, symbol]);

  return (
    <>
      <div className="panel filters">
        <CheckBar fmt={fmt} onDone={() => setN((x) => x + 1)} />
        <div className="muted small">
          After a Gold Buy the site watches the symbol&apos;s green fibs (red fibs for a Gold Sell) until price reaches 0.5, 0.618 or 0.786.
          A same-direction BOS or CHoCH after that touch makes it the stronger signal. Add your fibs on the My fibs tab.
        </div>
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="stronger">Fib + BOS/CHoCH</option>
            <option value="touched">At fib</option>
            <option value="waiting">Waiting for fib</option>
            <option value="expired">Expired</option>
          </select>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="3">Gold in last 3 days</option>
            <option value="7">Gold in last 7 days</option>
            <option value="14">Gold in last 14 days</option>
            <option value="30">Gold in last 30 days</option>
          </select>
          <input type="text" placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </div>
      </div>
      <div className="panel tablewrap">
        {err && <div className="status-err">{err}</div>}
        {shown && shown.length === 0 ? (
          <div className="empty">No Gold signals on symbols you have fibs for. Add fibs on the My fibs tab.</div>
        ) : (
          <table>
            <thead><tr><th>Status</th><th>Symbol</th><th>Gold</th><th>Fib</th><th>Touch</th><th>Then BOS/CHoCH</th></tr></thead>
            <tbody>
              {shown?.map((r) => (
                <tr key={`${r.gold_id}-${r.fib_id}`}>
                  <td><span className={`badge ${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  <td><b>{r.symbol}</b></td>
                  <td className="nowrap"><Sig code={r.code} /> {tfLabel(r.tf)}<div className="small muted">{fmt(r.signal_time)}</div></td>
                  <td className="nowrap">
                    <span className={r.direction === "bull" ? "sig bull" : "sig bear"}>{tfLabel(r.fib_tf)} {r.direction === "bull" ? "green" : "red"}</span>
                    <div className="small muted">{fibLevels({ direction: r.direction as "bull" | "bear", high: r.high, low: r.low }).map((l) => price(l.price)).join(" / ")}</div>
                    {r.note && <div className="small muted">{r.note}</div>}
                  </td>
                  <td className="nowrap">
                    {r.touched_at ? <>
                      <b>{r.ratio}</b> at {price(r.level)}
                      <div className="small muted">{r.at_signal ? "already there on the Gold bar" : fmt(r.touched_at)}</div>
                    </> : <span className="small muted">{r.status === "waiting" ? `watching until ${fmt(r.window_end)}` : "–"}</span>}
                  </td>
                  <td className="nowrap">
                    {r.structure_code ? <><Sig code={r.structure_code} /> {tfLabel(r.structure_tf!)}<div className="small muted">{fmt(r.structure_time!)}</div></> : <span className="small muted">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── Trends ───────────────────────────────

interface TrendRow {
  symbol: string; tf: string; trend: "up" | "down" | "range"; potential: "up" | "down" | null; since: string | null;
  last_high: { price: number; t: number; kind: string } | null; last_low: { price: number; t: number; kind: string } | null;
  price: number; note: string | null; updated_at: string;
}

const TREND_TEXT = { up: "↑ Up", down: "↓ Down", range: "↔ Range" };

export function Trends({ fmt, refresh }: { fmt: Fmt; refresh: number }) {
  const [rows, setRows] = useState<TrendRow[] | null>(null);
  const [err, setErr] = useState("");
  const [symbol, setSymbol] = useState("");
  const [onlyTurning, setOnlyTurning] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => { getJson<TrendRow[]>("/api/trends").then(setRows).catch((e) => setErr(e.message)); }, [refresh, n]);
  const bySymbol = useMemo(() => {
    const m = new Map<string, Record<string, TrendRow>>();
    for (const r of rows ?? []) {
      if (symbol && !r.symbol.includes(symbol.toUpperCase())) continue;
      m.set(r.symbol, { ...(m.get(r.symbol) ?? {}), [r.tf]: r });
    }
    return [...m.entries()].filter(([, tfs]) => !onlyTurning || Object.values(tfs).some((t) => t.potential));
  }, [rows, symbol, onlyTurning]);

  return (
    <>
      <div className="panel filters">
        <CheckBar fmt={fmt} onDone={() => setN((x) => x + 1)} />
        <div className="muted small">
          From each timeframe&apos;s confirmed swing highs and lows (5 bars either side) on Bitget prices: higher high + higher low is an uptrend,
          lower high + lower low a downtrend. ⚠ marks a potential change: a higher high in a downtrend, or a lower low in an uptrend.
          Symbols with a signal in the last 7 days, or a fib, are tracked.
        </div>
        <div className="row">
          <input type="text" placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
          <label className="small"><input type="checkbox" checked={onlyTurning} onChange={(e) => setOnlyTurning(e.target.checked)} /> Only symbols with a potential change</label>
        </div>
      </div>
      <div className="panel tablewrap">
        {err && <div className="status-err">{err}</div>}
        {rows && bySymbol.length === 0 ? <div className="empty">No trends yet. Press Check now.</div> : (
          <table className="board">
            <thead><tr><th>Symbol</th>{TREND_TFS.map((tf) => <th key={tf}>{tfLabel(tf)}</th>)}</tr></thead>
            <tbody>
              {bySymbol.map(([sym, tfs]) => (
                <tr key={sym}>
                  <td><b>{sym}</b><div className="small muted">{price(tfs["15m"]?.price)}</div></td>
                  {TREND_TFS.map((tf) => {
                    const t = tfs[tf];
                    if (!t) return <td key={tf} className="muted">–</td>;
                    return (
                      <td key={tf} title={t.note ?? ""}>
                        <span className={`sig ${t.trend === "up" ? "bull" : t.trend === "down" ? "bear" : ""}`}>{TREND_TEXT[t.trend]}</span>
                        {t.potential && <span className="warn"> ⚠ turning {t.potential === "up" ? "↑" : "↓"}</span>}
                        <span className="line muted">
                          {t.last_high && `${t.last_high.kind} ${price(t.last_high.price)}`}{t.last_high && t.last_low && " · "}{t.last_low && `${t.last_low.kind} ${price(t.last_low.price)}`}
                        </span>
                        {t.potential && t.note && <span className="line muted">{t.note}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── My fibs ───────────────────────────────

interface FibRow { id: number; symbol: string; tf: string; direction: "bull" | "bear"; high: number; low: number; note: string | null; active: boolean; created_at: string; price: number | null }

const EMPTY = { symbol: "", tf: "1h", direction: "bull", high: "", low: "", note: "" };

export function Fibs({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<FibRow[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => { getJson<FibRow[]>("/api/fibs").then(setRows).catch((e) => setErr(e.message)); }, [refresh, n]);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const preview = Number(form.high) > Number(form.low) && Number(form.low) > 0
    ? fibLevels({ direction: form.direction as "bull" | "bear", high: Number(form.high), low: Number(form.low) }) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await send(editing ? `/api/fibs/${editing}` : "/api/fibs", editing ? "PATCH" : "POST", form);
      setForm({ ...EMPTY, tf: form.tf, direction: form.direction });
      setEditing(null);
      setN((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const act = async (f: FibRow, what: "toggle" | "delete") => {
    if (what === "delete" && !window.confirm(`Delete the ${f.symbol} ${tfLabel(f.tf)} fib?`)) return;
    try {
      if (what === "delete") await send(`/api/fibs/${f.id}`, "DELETE");
      else await send(`/api/fibs/${f.id}`, "PATCH", { active: !f.active });
      setN((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <>
      <form className="panel" onSubmit={submit}>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Copy each fib you draw in TradingView: the swing high and swing low it&apos;s anchored to. Green fibs look for a bullish retest after a Gold Buy,
          red fibs a bearish retest after a Gold Sell. Switch a fib off when it no longer applies.
        </div>
        <div className="row">
          <input type="text" placeholder="Symbol, e.g. BTCUSDT.P" value={form.symbol} onChange={set("symbol")} required />
          <select value={form.tf} onChange={set("tf")}><option value="1h">1H</option><option value="4h">4H</option></select>
          <select value={form.direction} onChange={set("direction")}>
            <option value="bull">🟢 Green (bullish retest)</option>
            <option value="bear">🔴 Red (bearish retest)</option>
          </select>
          <input type="text" inputMode="decimal" placeholder="Swing high" value={form.high} onChange={set("high")} required />
          <input type="text" inputMode="decimal" placeholder="Swing low" value={form.low} onChange={set("low")} required />
          <input type="text" placeholder="Note (optional)" value={form.note} onChange={set("note")} />
          <button className="btn" type="submit">{editing ? "Save fib" : "Add fib"}</button>
          {editing && <button className="btn" type="button" onClick={() => { setEditing(null); setForm(EMPTY); }}>Cancel</button>}
        </div>
        {preview && <div className="small muted" style={{ marginTop: 6 }}>Levels: {preview.map((l) => `${l.ratio} = ${price(l.price)}`).join(" · ")}</div>}
        {err && <div className="status-err">{err}</div>}
      </form>
      <div className="panel tablewrap">
        {rows && rows.length === 0 ? <div className="empty">No fibs yet.</div> : (
          <table>
            <thead><tr><th>Symbol</th><th>Fib</th><th>High / low</th><th>0.5 · 0.618 · 0.786</th><th>Price now</th><th></th></tr></thead>
            <tbody>
              {rows?.map((f) => (
                <tr key={f.id} style={f.active ? undefined : { opacity: 0.5 }}>
                  <td><b>{f.symbol}</b>{f.note && <div className="small muted">{f.note}</div>}</td>
                  <td className="nowrap"><span className={`sig ${f.direction}`}>{tfLabel(f.tf)} {f.direction === "bull" ? "green" : "red"}</span></td>
                  <td className="nowrap">{price(f.high)} / {price(f.low)}</td>
                  <td className="nowrap">{fibLevels(f).map((l) => {
                    const dist = f.price ? ((f.price - l.price) / l.price) * 100 : null;
                    return <div key={l.ratio}>{l.ratio}: {price(l.price)}{dist != null && <span className="small muted"> ({dist > 0 ? "+" : ""}{dist.toFixed(2)}%)</span>}</div>;
                  })}</td>
                  <td>{price(f.price)}</td>
                  <td className="nowrap">
                    <button className="btn small" onClick={() => { setEditing(f.id); setForm({ symbol: f.symbol, tf: f.tf, direction: f.direction, high: String(f.high), low: String(f.low), note: f.note ?? "" }); }}>Edit</button>{" "}
                    <button className="btn small" onClick={() => act(f, "toggle")}>{f.active ? "Switch off" : "Switch on"}</button>{" "}
                    <button className="btn danger small" onClick={() => act(f, "delete")}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────── Telegram ───────────────────────────────

interface AlertSettings {
  gold: boolean; goldStructure: boolean; fibTouch: boolean; fibStructure: boolean; trendChange: boolean; trendPotential: boolean;
  trendTfs: string[]; fibTolerancePct: number;
}
interface TelegramInfo {
  status: { configured: boolean; bot: string | null; chatId: string | null; chatFromEnv: boolean; error: string | null };
  settings: AlertSettings;
  recent: Array<{ key: string; text: string; sent_at: string }>;
}

const TOGGLES: Array<[keyof AlertSettings, string]> = [
  ["fibStructure", "💥 Gold → fib touch → BOS/CHoCH (strongest)"],
  ["fibTouch", "🎯 Gold → price at a matching fib"],
  ["goldStructure", "✅ Gold → same-direction BOS/CHoCH"],
  ["trendPotential", "⚠️ Potential trend change"],
  ["trendChange", "Trend flipped up or down"],
  ["gold", "Every new Gold signal"],
];

export function Alerts({ fmt }: { fmt: Fmt }) {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => getJson<TelegramInfo>("/api/telegram").then(setInfo).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const action = async (body: unknown, ok: string) => {
    setErr(""); setMsg("");
    try {
      const r = await send("/api/telegram", "POST", body);
      setMsg(ok.replace("{name}", r.name ?? ""));
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const save = (patch: Partial<AlertSettings>) => action({ action: "settings", settings: { ...info!.settings, ...patch } }, "Saved.");
  if (!info) return <div className="panel">{err ? <span className="status-err">{err}</span> : "Loading…"}</div>;
  const s = info.status;

  return (
    <>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Telegram</h3>
        {!s.configured ? (
          <ol className="small">
            <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code> and follow the steps. It gives you a bot token.</li>
            <li>In Vercel, open the confluence-radar project → Settings → Environment Variables, add <code>TELEGRAM_BOT_TOKEN</code> with that token, then redeploy.</li>
            <li>Open your new bot in Telegram and press <b>Start</b>. Then come back here and press <b>Find my chat</b>.</li>
          </ol>
        ) : (
          <div className="row small">
            <span>Bot: {s.bot ? <b>@{s.bot}</b> : <span className="status-err">{s.error}</span>}</span>
            <span>Chat: {s.chatId ? <b>{s.chatId}</b> : <span className="warn">not found yet. Send your bot a message, then press Find my chat.</span>}</span>
            {!s.chatFromEnv && <button className="btn small" onClick={() => action({ action: "discover" }, "Found your chat {name}.")}>Find my chat</button>}
            <button className="btn small" disabled={!s.chatId} onClick={() => action({ action: "test" }, "Test message sent.")}>Send a test message</button>
          </div>
        )}
        {msg && <div className="status-ok small">{msg}</div>}
        {err && <div className="status-err small">{err}</div>}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>What to send</h3>
        {TOGGLES.map(([k, label]) => (
          <div key={k}><label><input type="checkbox" checked={info.settings[k] as boolean} onChange={(e) => save({ [k]: e.target.checked })} /> {label}</label></div>
        ))}
        <div className="row small" style={{ marginTop: 8 }}>
          <span>Trend alerts for</span>
          {TREND_TFS.map((tf) => (
            <label key={tf}><input type="checkbox" checked={info.settings.trendTfs.includes(tf)}
              onChange={(e) => save({ trendTfs: e.target.checked ? [...info.settings.trendTfs, tf] : info.settings.trendTfs.filter((x) => x !== tf) })} /> {tfLabel(tf)}</label>
          ))}
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <label>A fib counts as touched within&nbsp;
            <input type="number" step="0.05" min="0" max="5" style={{ width: 70 }} defaultValue={info.settings.fibTolerancePct}
              onBlur={(e) => save({ fibTolerancePct: Number(e.target.value) })} />% of the level
          </label>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>Only events from the last 3 hours are sent, so turning something on doesn&apos;t send old history.</div>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Recently sent</h3>
        {info.recent.length === 0 ? <div className="muted small">Nothing sent yet.</div> : info.recent.map((a) => (
          <div key={a.key} className="small" style={{ marginBottom: 8 }}>
            <span className="muted">{fmt(a.sent_at)}</span>{" "}
            <span dangerouslySetInnerHTML={{ __html: a.text.replace(/\n/g, "<br>") }} />
          </div>
        ))}
      </div>
    </>
  );
}
