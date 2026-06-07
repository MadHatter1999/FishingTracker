import { LOCATION } from "../config";

const TZ = LOCATION.tz;

export function fmtTime(d: Date | null): string {
  if (!d) return "-";
  return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}

export function fmtHour(d: Date): string {
  return d.toLocaleTimeString("en-CA", { hour: "numeric", timeZone: TZ });
}

export function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
}

export function fmtWeekday(d: Date): string {
  return d.toLocaleDateString("en-CA", { weekday: "short", timeZone: TZ });
}

export function fmtRange(a: Date, b: Date): string {
  return `${fmtTime(a)} - ${fmtTime(b)}`;
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: TZ });
}

export function todayKey(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
