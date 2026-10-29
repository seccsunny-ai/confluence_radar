"use client";

import { SIGNAL_BY_CODE } from "@/lib/signals";

// Small pieces shared by the page's tabs.

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 0) return "in future";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

export function Sig({ code }: { code: string }) {
  const d = SIGNAL_BY_CODE[code];
  if (!d) return <span className="sig">{code}</span>;
  const cls = d.family === "gold" ? "gold" : d.direction;
  return <span className={`sig ${cls}`} title={d.name}>{d.label}</span>;
}

export function Chips<T extends string>({ options, value, onChange, render }: {
  options: T[]; value: T[]; onChange: (v: T[]) => void; render?: (o: T) => React.ReactNode;
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <span key={o} className={`chip ${value.includes(o) ? "on" : ""}`}
          onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>
          {render ? render(o) : o}
        </span>
      ))}
    </div>
  );
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}
