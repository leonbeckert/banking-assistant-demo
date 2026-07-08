// Deterministic support-hours model. NO LLM - a mock clock + a static config, so the
// advisor route's promise is a pure function of the time. Pure TS (no fs/node), so the
// UI imports it client-side for the button label and the handoff confirm card, and the
// API routes import it server-side for the handoff receipt. Same numbers everywhere.
//
// DOCTRINE: hours are STATES, not GATES. Out-of-hours never DISABLES the human route -
// it changes the PROMISE (async intake with a reply-by time). The emergency card-
// opposition line is the one exception: it runs 24/7 and is surfaced by the fraud route.

export interface DayHours {
  open: number; // minutes-since-midnight, inclusive
  close: number; // minutes-since-midnight, exclusive
}

// Day index matches Date.getDay(): 0 = Sunday … 6 = Saturday.
// Mon-Fri 08:00-19:00, Sat 09:00-13:00, Sun closed.
export const SUPPORT_HOURS: Record<number, DayHours | null> = {
  0: null, // Sun - closed
  1: { open: 8 * 60, close: 19 * 60 }, // Mon
  2: { open: 8 * 60, close: 19 * 60 }, // Tue
  3: { open: 8 * 60, close: 19 * 60 }, // Wed
  4: { open: 8 * 60, close: 19 * 60 }, // Thu
  5: { open: 8 * 60, close: 19 * 60 }, // Fri
  6: { open: 9 * 60, close: 13 * 60 }, // Sat
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

// Are advisors staffing the live route right now?
export function isOpen(now: Date): boolean {
  const cfg = SUPPORT_HOURS[now.getDay()];
  if (!cfg) return false;
  const m = minutesOfDay(now);
  return m >= cfg.open && m < cfg.close;
}

function fmt(day: number, openMinutes: number): string {
  const h = Math.floor(openMinutes / 60);
  const mm = String(openMinutes % 60).padStart(2, "0");
  return `${DAY_NAMES[day]} ${h}:${mm}`;
}

// The next time advisors open, as a short label e.g. "Mon 8:00". Scans forward up to a
// week: later today if still before opening, otherwise the next staffed day.
export function nextOpening(now: Date): string {
  const today = SUPPORT_HOURS[now.getDay()];
  if (today && minutesOfDay(now) < today.open) {
    return fmt(now.getDay(), today.open); // opens later today
  }
  for (let i = 1; i <= 7; i += 1) {
    const day = (now.getDay() + i) % 7;
    const cfg = SUPPORT_HOURS[day];
    if (cfg) return fmt(day, cfg.open);
  }
  return fmt(1, SUPPORT_HOURS[1]!.open); // unreachable - a week always has an open day
}

// Deterministic demo clock. The out-of-hours state is driven by a gear toggle, not the
// real wall-clock, so screenshots are reproducible. In-hours → a Monday 10:00 (open).
// Out-of-hours → a Sunday 20:00 (closed) → nextOpening() == "Mon 8:00".
export function mockNow(outOfHours: boolean): Date {
  return outOfHours ? new Date("2026-01-04T20:00:00") : new Date("2026-01-05T10:00:00");
}
