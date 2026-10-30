"use client";

import { useEffect, useMemo, useState } from "react";
import { fibLevels } from "@/lib/fibs";
import { getJson } from "./ui";
import { playSound, price, SOUNDS, type AlarmSettings, type PriceAlertRow } from "./fib-alarm";

// My alerts: price levels the user sets on any symbol, from one of its drawn fibs or typed in, with an optional note.
// The background check fires each one once, sends it to Telegram on its own and rings the site's alarm.

type Fmt = (s: string) => string;

interface FibRow {
  id: number; symbol: string; tf: string; direction: "bull" | "bear"; high: number; low: number;
  source: "manual" | "auto"; forming: boolean; active: boolean; note: string | null;
}

const tfLabel = (tf: string) => tf.replace(/h$/, "H");
const TF_ORDER = ["15m", "1h", "2h", "4h", "1D", "1W"];

async function send(url: string, method: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export function PriceAlerts({ fmt, refresh, alarm, setAlarm }: {
  fmt: Fmt; refresh: number; alarm: AlarmSettings; setAlarm: (p: Partial<AlarmSettings>) => void;
}) {
  const [rows, setRows] = useState<PriceAlertRow[] | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [fibs, setFibs] = useState<FibRow[]>([]);
  const [symbol, setSymbol] = useState("");
  const [level, setLevel] = useState("custom"); // "custom" or "<fib id>:<ratio>"
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);

  useEffect(() => {
    getJson<{ alerts: PriceAlertRow[]; symbols: string[] }>("/api/price-alerts")
      .then((r) => { setRows(r.alerts); setSymbols(r.symbols); })
      .catch((e) => setErr(e.message));
  }, [refresh, n]);
  useEffect(() => { getJson<FibRow[]>("/api/fibs").then(setFibs).catch(() => {}); }, [refresh]);

  const sym = symbol.trim().toUpperCase();
  const symFibs = useMemo(() => fibs
    .filter((f) => f.active && f.symbol === sym)
    .sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf)), [fibs, sym]);
  useEffect(() => setLevel("custom"), [sym]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const [fibId, ratio] = level === "custom" ? [] : level.split(":").map(Number);
      await send("/api/price-alerts", "POST", level === "custom"
        ? { symbol: sym, level: custom, note }
        : { symbol: sym, fibId, ratio, note });
      setCustom("");
      setNote("");
      setN((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (a: PriceAlertRow, what: "rearm" | "delete") => {
    if (what === "delete" && !window.confirm(`Delete the ${a.symbol} alert at ${price(a.level)}?`)) return;
    try {
      if (what === "delete") await send(`/api/price-alerts/${a.id}`, "DELETE");
      else await send(`/api/price-alerts/${a.id}`, "PATCH", { rearm: true });
      setN((x) => x + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const waiting = rows?.filter((a) => !a.triggered_at) ?? [];
  const fired = rows?.filter((a) => a.triggered_at) ?? [];

  const table = (list: PriceAlertRow[], done: boolean) => (
    <table>
      <thead><tr><th>Symbol</th><th>Level</th><th>Note</th><th>{done ? "Reached" : "Price now"}</th><th></th></tr></thead>
      <tbody>
        {list.map((a) => {
          const dist = a.price ? ((a.level - a.price) / a.price) * 100 : null;
          return (
            <tr key={a.id} className={done ? "hit-row hit-custom" : undefined}>
              <td><b>{a.symbol}</b><div className="small muted">set {fmt(a.created_at)}</div></td>
              <td className="nowrap">
                <b>{price(a.level)}</b>
                <div className="small muted">
                  {a.fib_label ?? "my price"}
                  {a.direction && ` · when price ${done ? (a.direction === "up" ? "rose" : "fell") : a.direction === "up" ? "rises" : "falls"} to it`}
                </div>
              </td>
              <td className="small">{a.note}</td>
              <td className="nowrap">
                {done ? <>{fmt(a.triggered_at!)}<div className="small muted">price then {price(a.trigger_price)}</div></>
                  : <>{price(a.price)}{dist != null && <span className="small muted"> ({dist > 0 ? "+" : ""}{dist.toFixed(2)}% to go)</span>}</>}
              </td>
              <td className="nowrap">
                {done && <><button className="btn small" onClick={() => act(a, "rearm")}>Watch again</button>{" "}</>}
                <button className="btn danger small" onClick={() => act(a, "delete")}>Delete</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <>
      <form className="panel" onSubmit={add}>
        <h3 style={{ marginTop: 0 }}>New alert</h3>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Pick a symbol from the list or type any Bitget perpetual (e.g. BTCUSDT.P). For a symbol with fibs drawn, you can pick one of their levels,
          or type your own price. The alert fires once, the first time price reaches the level after you set it (checked every 15 minutes with
          1-minute candles). It comes to Telegram as its own message and rings the alarm here. A fib level is copied when you set the alert, so it
          stays put even if the fib moves or goes.
        </div>
        <div className="row">
          <input type="text" list="alert-symbols" placeholder="Symbol, e.g. BTCUSDT.P" value={symbol}
            onChange={(e) => setSymbol(e.target.value)} required />
          <datalist id="alert-symbols">{symbols.map((s) => <option key={s} value={s} />)}</datalist>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="custom">My own price</option>
            {symFibs.map((f) => (
              <optgroup key={f.id} label={`${tfLabel(f.tf)} ${f.direction === "bull" ? "🟢 green" : "🔴 red"} fib${f.source === "manual" ? " (mine)" : f.forming ? " (forming)" : ""}`}>
                {fibLevels(f).map((l) => <option key={l.ratio} value={`${f.id}:${l.ratio}`}>{l.ratio} = {price(l.price)}</option>)}
              </optgroup>
            ))}
          </select>
          {level === "custom" && (
            <input type="text" inputMode="decimal" placeholder="Price" value={custom} onChange={(e) => setCustom(e.target.value)} required />
          )}
          <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="grow" maxLength={300} />
          <button className="btn primary" type="submit" disabled={busy || !sym}>{busy ? "Adding…" : "Add alert"}</button>
        </div>
        {sym && symbols.length > 0 && !symFibs.length && (
          <div className="small muted" style={{ marginTop: 6 }}>No fibs drawn for {sym} right now, so type a price.</div>
        )}
        {err && <div className="status-err">{err}</div>}
        <div className="row small" style={{ marginTop: 10 }}>
          <label><input type="checkbox" checked={alarm.on} onChange={(e) => setAlarm({ on: e.target.checked })} /> Alarm on</label>
          <span className="muted">Sound for my alerts</span>
          <select value={alarm.sounds.custom} onChange={(e) => setAlarm({ sounds: { ...alarm.sounds, custom: e.target.value } })}>
            {Object.entries(SOUNDS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
          </select>
          <button type="button" className="btn small" onClick={() => playSound(alarm.sounds.custom, alarm.volume)}>▶ Test</button>
          <span className="muted">Volume and notifications are on the Fib hits tab.</span>
        </div>
      </form>
      <div className="panel tablewrap">
        <h3 style={{ marginTop: 0 }}>Waiting</h3>
        {!rows ? "Loading…" : waiting.length === 0 ? <div className="empty">No alerts waiting.</div> : table(waiting, false)}
      </div>
      {fired.length > 0 && (
        <div className="panel tablewrap">
          <h3 style={{ marginTop: 0 }}>Reached (last 30 days)</h3>
          {table(fired, true)}
        </div>
      )}
    </>
  );
}
