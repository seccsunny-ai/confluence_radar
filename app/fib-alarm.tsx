"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "./ui";

// The alarm: while the site is open it checks every minute for new fib hits and for the user's own price alerts that
// fired, and plays a sound (and can show a browser notification). Both are found by the background check every 15 minutes.

type Fmt = (s: string) => string;
export type Kind = "bull" | "bear" | "gold" | "custom";

export interface LevelHit {
  id: number; symbol: string; tf: string; direction: "bull" | "bear"; ratio: number; level: number; hit_at: string; detected_at: string;
  high: number; low: number; source: "manual" | "auto"; forming: boolean; active: boolean; price: number | null; confluence: boolean;
}

/** One of the user's own price alerts (see /api/price-alerts). */
export interface PriceAlertRow {
  id: number; symbol: string; level: number; direction: "up" | "down" | null; fib_id: number | null; fib_label: string | null;
  note: string | null; created_at: string; triggered_at: string | null; detected_at: string | null; trigger_price: number | null;
  price?: number | null;
}

export interface AlarmSettings {
  on: boolean;
  volume: number; // 0..1
  sounds: Record<Kind, string>;
  notify: boolean;
  only: "all" | "gold"; // ring for every hit, or only Gold + fib confluences
}

const DEFAULT_ALARM: AlarmSettings = { on: false, volume: 0.7, sounds: { bull: "rise", bear: "fall", gold: "bell", custom: "alarm" }, notify: false, only: "all" };

type Note = [freq: number, start: number, dur: number, wave: OscillatorType];
export const SOUNDS: Record<string, { label: string; notes: Note[] }> = {
  rise: { label: "Rising chime", notes: [[523, 0, 0.18, "triangle"], [659, 0.15, 0.18, "triangle"], [784, 0.3, 0.45, "triangle"]] },
  fall: { label: "Falling chime", notes: [[784, 0, 0.18, "triangle"], [659, 0.15, 0.18, "triangle"], [523, 0.3, 0.45, "triangle"]] },
  bell: { label: "Bell", notes: [[660, 0, 1.6, "sine"], [1320, 0, 1.0, "sine"], [1980, 0, 0.6, "sine"], [660, 0.5, 1.4, "sine"]] },
  chime: { label: "Ding-dong", notes: [[880, 0, 0.5, "sine"], [659, 0.35, 0.8, "sine"]] },
  beep: { label: "Triple beep", notes: [[1000, 0, 0.12, "square"], [1000, 0.2, 0.12, "square"], [1000, 0.4, 0.12, "square"]] },
  coin: { label: "Coin", notes: [[988, 0, 0.09, "square"], [1319, 0.09, 0.4, "square"]] },
  alarm: {
    label: "Alarm clock",
    notes: Array.from({ length: 10 }, (_, i): Note => [i % 2 ? 1000 : 750, i * 0.16, 0.14, "sawtooth"]),
  },
};

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function playSound(name: string, volume: number) {
  const ac = audio();
  const s = SOUNDS[name] ?? SOUNDS.bell;
  if (!ac) return;
  const t0 = ac.currentTime + 0.02;
  for (const [freq, start, dur, wave] of s.notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    const peak = Math.max(0.0001, volume * (wave === "sine" || wave === "triangle" ? 0.45 : 0.12));
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.05);
  }
}

export const KIND_LABEL: Record<Kind, string> = {
  bull: "Green fib (bullish retest)", bear: "Red fib (bearish retest)", gold: "Gold + fib confluence", custom: "⏰ My alerts",
};

export const hitKind = (h: Pick<LevelHit, "direction" | "confluence">): Kind => (h.confluence ? "gold" : h.direction);
const tfLabel = (tf: string) => tf.replace(/h$/, "H");
const short = (s: string) => s.replace(/USDT\.P$/, "");

export function price(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "–";
  const abs = Math.abs(p);
  return String(Number(p.toFixed(abs >= 1000 ? 1 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8)));
}

export const hitText = (h: LevelHit) =>
  `${short(h.symbol)} · ${tfLabel(h.tf)} ${h.direction === "bull" ? "green" : "red"} fib ${h.ratio} hit at ${price(h.level)}` +
  (h.confluence ? ` · Gold ${h.direction === "bull" ? "Buy" : "Sell"} confluence` : "");

export const alertText = (a: PriceAlertRow) =>
  `⏰ ${short(a.symbol)} ${a.direction === "down" ? "fell to" : a.direction === "up" ? "rose to" : "reached"} ${price(a.level)}` +
  (a.fib_label ? ` · ${a.fib_label}` : "") + (a.note ? ` · ${a.note}` : "");

interface Toast { key: string; kind: Kind; text: string }

/** Alarm settings, kept in this browser. */
export function useAlarm(): [AlarmSettings, (patch: Partial<AlarmSettings>) => void] {
  const [s, setS] = useState<AlarmSettings>(DEFAULT_ALARM);
  useEffect(() => {
    try {
      const v = localStorage.getItem("fibAlarm");
      if (v) {
        const saved = JSON.parse(v) as Partial<AlarmSettings>;
        setS({ ...DEFAULT_ALARM, ...saved, sounds: { ...DEFAULT_ALARM.sounds, ...saved.sounds } });
      }
    } catch { /* private window: defaults */ }
  }, []);
  const update = useCallback((patch: Partial<AlarmSettings>) => setS((old) => {
    const next = { ...old, ...patch };
    try { localStorage.setItem("fibAlarm", JSON.stringify(next)); } catch { /* not saved */ }
    return next;
  }), []);
  return [s, update];
}

/** Watches for new fib hits and fired price alerts while the page is open; rings and shows them in the corner. */
export function FibAlarm({ alarm, setAlarm, onHits }: { alarm: AlarmSettings; setAlarm: (p: Partial<AlarmSettings>) => void; onHits: () => void }) {
  const lastId = useRef<number | null>(null);
  const lastAlert = useRef<string | null>(null); // detected_at of the newest fired price alert seen
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [blocked, setBlocked] = useState(false);

  const ring = useCallback((items: Toast[], title: string) => {
    if (!alarm.on || !items.length) return;
    setToasts((t) => [...items, ...t.filter((x) => !items.some((i) => i.key === x.key))].slice(0, 8));
    const kind = (["custom", "gold", "bull", "bear"] as Kind[]).find((k) => items.some((i) => i.kind === k))!;
    playSound(alarm.sounds[kind], alarm.volume);
    setBlocked(audio()?.state === "suspended");
    if (alarm.notify && "Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body: items.slice(0, 4).map((i) => i.text).join("\n"), tag: kind === "custom" ? "price-alert" : "fib-hit" });
    }
  }, [alarm]);

  const pollHits = useCallback(async () => {
    if (lastId.current == null) {
      const rows = await getJson<LevelHit[]>("/api/level-hits?days=1");
      lastId.current = rows[0]?.id ?? 0;
      return;
    }
    const rows = await getJson<LevelHit[]>(`/api/level-hits?after=${lastId.current}`);
    if (!rows.length) return;
    lastId.current = Math.max(lastId.current, ...rows.map((r) => r.id));
    onHits();
    const hits = rows.filter((r) => r.active && (alarm.only === "all" || r.confluence));
    ring(hits.map((h) => ({ key: `h${h.id}`, kind: hitKind(h), text: hitText(h) })), hits.length === 1 ? "Fib hit" : `${hits.length} fib hits`);
  }, [alarm.only, onHits, ring]);

  const pollAlerts = useCallback(async () => {
    if (lastAlert.current == null) {
      const { alerts } = await getJson<{ alerts: PriceAlertRow[] }>("/api/price-alerts");
      lastAlert.current = alerts.reduce((m, a) => (a.detected_at && a.detected_at > m ? a.detected_at : m), new Date(0).toISOString());
      return;
    }
    const rows = await getJson<PriceAlertRow[]>(`/api/price-alerts?after=${encodeURIComponent(lastAlert.current)}`);
    if (!rows.length) return;
    lastAlert.current = rows.reduce((m, a) => (a.detected_at! > m ? a.detected_at! : m), lastAlert.current);
    onHits();
    ring(rows.map((a) => ({ key: `a${a.id}:${a.triggered_at}`, kind: "custom", text: alertText(a) })), rows.length === 1 ? "Price alert" : `${rows.length} price alerts`);
  }, [onHits, ring]);

  const poll = useCallback(async () => {
    // Each on its own, so one failing (offline for a moment) doesn't stop the other; both try again next minute
    await Promise.allSettled([pollAlerts(), pollHits()]);
  }, [pollAlerts, pollHits]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [poll]);

  // Browsers only allow sound after a click on the page
  useEffect(() => {
    const unlock = () => { if (alarm.on) { audio(); setBlocked(false); } };
    document.addEventListener("pointerdown", unlock);
    return () => document.removeEventListener("pointerdown", unlock);
  }, [alarm.on]);

  return (
    <>
      <button className={`btn small alarm-chip ${alarm.on ? "on" : ""}`} title="Sound when price hits a fib level or one of your alerts (while this page is open)"
        onClick={() => { const on = !alarm.on; setAlarm({ on }); if (on) playSound(alarm.sounds.gold, alarm.volume); }}>
        {alarm.on ? "🔔 Alarm on" : "🔕 Alarm off"}
      </button>
      {blocked && alarm.on && <span className="warn">Click anywhere on the page to allow the alarm sound.</span>}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((h) => (
            <div key={h.key} className={`toast hit-${h.kind}`}>
              <span>{h.text}</span>
              <button className="x" onClick={() => setToasts((t) => t.filter((x) => x.key !== h.key))}>×</button>
            </div>
          ))}
          {toasts.length > 1 && <button className="btn small" onClick={() => setToasts([])}>Dismiss all</button>}
        </div>
      )}
    </>
  );
}

/** The Fib hits tab: alarm settings and the list of hits, coloured by kind. */
export function FibHits({ fmt, refresh, alarm, setAlarm }: { fmt: Fmt; refresh: number; alarm: AlarmSettings; setAlarm: (p: Partial<AlarmSettings>) => void }) {
  const [rows, setRows] = useState<LevelHit[] | null>(null);
  const [days, setDays] = useState("3");
  const [symbol, setSymbol] = useState("");
  const [kind, setKind] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<LevelHit[]>(`/api/level-hits?days=${days}`).then((r) => { setRows(r); setErr(""); }).catch((e) => setErr(e.message));
  }, [days, refresh]);
  const shown = useMemo(() => rows?.filter((r) => (!symbol || r.symbol.includes(symbol.toUpperCase())) && (!kind || hitKind(r) === kind)), [rows, symbol, kind]);
  const notifyState = typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";

  return (
    <>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Alarm</h3>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Rings on this device while the site is open in a tab, for fib hits and for your own alerts (it checks every minute; the site
          looks for fib hits and alerts every 15 minutes).
          Settings are kept in this browser.
        </div>
        <div className="row">
          <label><input type="checkbox" checked={alarm.on} onChange={(e) => { setAlarm({ on: e.target.checked }); if (e.target.checked) audio(); }} /> Alarm on</label>
          <select value={alarm.only} onChange={(e) => setAlarm({ only: e.target.value as AlarmSettings["only"] })}>
            <option value="all">Ring for every fib hit</option>
            <option value="gold">Ring only for Gold + fib confluences</option>
          </select>
          <label className="small">Volume <input type="range" min="0" max="1" step="0.05" value={alarm.volume} onChange={(e) => setAlarm({ volume: Number(e.target.value) })} /></label>
        </div>
        {(["bull", "bear", "gold", "custom"] as Kind[]).map((k) => (
          <div key={k} className="row" style={{ marginTop: 8 }}>
            <span className={`hit-pill hit-${k}`}>{KIND_LABEL[k]}</span>
            <select value={alarm.sounds[k]} onChange={(e) => setAlarm({ sounds: { ...alarm.sounds, [k]: e.target.value } })}>
              {Object.entries(SOUNDS).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
            </select>
            <button className="btn small" onClick={() => playSound(alarm.sounds[k], alarm.volume)}>▶ Test</button>
          </div>
        ))}
        <div className="row small" style={{ marginTop: 8 }}>
          <label><input type="checkbox" checked={alarm.notify} disabled={notifyState === "unsupported" || notifyState === "denied"}
            onChange={async (e) => {
              const on = e.target.checked;
              if (on && Notification.permission !== "granted") await Notification.requestPermission();
              setAlarm({ notify: on && Notification.permission === "granted" });
            }} /> Also show a browser notification</label>
          {notifyState === "denied" && <span className="warn">Notifications are blocked for this site in your browser settings.</span>}
        </div>
      </div>
      <div className="panel filters">
        <div className="row">
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="1">Last 24 hours</option>
            <option value="3">Last 3 days</option>
            <option value="7">Last 7 days</option>
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All hits</option>
            <option value="gold">🟡 Gold + fib confluence</option>
            <option value="bull">🟢 Bullish retest</option>
            <option value="bear">🔴 Bearish retest</option>
          </select>
          <input type="text" placeholder="Symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </div>
      </div>
      <div className="panel tablewrap">
        {err && <div className="status-err">{err}</div>}
        {shown && shown.length === 0 ? <div className="empty">No fib hits yet.</div> : (
          <table>
            <thead><tr><th>Hit</th><th>Symbol</th><th>Fib</th><th>Level</th><th>Price now</th></tr></thead>
            <tbody>
              {shown?.map((h) => {
                const dist = h.price ? ((h.price - h.level) / h.level) * 100 : null;
                return (
                  <tr key={h.id} className={`hit-row hit-${hitKind(h)}`} style={h.active ? undefined : { opacity: 0.55 }}>
                    <td className="nowrap">{fmt(h.hit_at)}</td>
                    <td><b>{short(h.symbol)}</b></td>
                    <td className="nowrap">
                      {tfLabel(h.tf)} {h.direction === "bull" ? "green" : "red"} fib
                      <div className="small muted">
                        {h.confluence ? `Gold ${h.direction === "bull" ? "Buy" : "Sell"} confluence` : h.direction === "bull" ? "bullish retest" : "bearish retest"}
                        {h.forming ? " · leg forming" : ""}{h.active ? "" : " · fib since broken"}
                      </div>
                    </td>
                    <td className="nowrap"><b>{h.ratio}</b> = {price(h.level)}</td>
                    <td className="nowrap">{price(h.price)}{dist != null && <span className="small muted"> ({dist > 0 ? "+" : ""}{dist.toFixed(2)}%)</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
