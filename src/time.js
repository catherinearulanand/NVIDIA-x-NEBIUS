// Timezone helpers built on Intl, so plans keep an explicit IANA timezone
// without pulling in a date library.

function partsIn(timeZone, date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

// Offset of `timeZone` from UTC at instant `date`, in minutes.
export function offsetMinutes(timeZone, date) {
  const p = partsIn(timeZone, date);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "2026-10-30" + "14:00" in Asia/Kolkata -> Date (UTC instant).
export function zonedToDate(localDate, hhmm, timeZone) {
  const [y, m, d] = localDate.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = offsetMinutes(timeZone, new Date(guess));
  let t = guess - off * 60000;
  // Second pass handles instants near a DST transition.
  const off2 = offsetMinutes(timeZone, new Date(t));
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

export function localDateOf(date, timeZone) {
  const p = partsIn(timeZone, date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTimeOf(date, timeZone) {
  const p = partsIn(timeZone, date);
  return `${p.hour}:${p.minute}`;
}

export function addDays(localDate, n) {
  const [y, m, d] = localDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// ISO string with the zone's offset, e.g. 2026-10-30T14:00:00+05:30.
export function toZonedIso(date, timeZone) {
  const off = offsetMinutes(timeZone, date);
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  const p = partsIn(timeZone, date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function weekdayOf(localDate) {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
