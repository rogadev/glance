// Scheduled work for glance: ScheduleWakeup (/loop) wakeups and CronCreate jobs.
// Pure functions; glance.mjs keeps the entries in the session's background map.

const MINUTE = 60 * 1000;

// How far ahead a scheduled run still counts as "working". A job that fires
// tomorrow morning shouldn't keep the pane tinted overnight.
export const SCHEDULE_HORIZON_MS = 60 * MINUTE;

// How late a run may arrive before glance assumes it was missed.
const GRACE_MS = 2 * MINUTE;

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/**
 * Parses a standard 5-field cron expression (local time). Supports *, lists,
 * ranges, and steps; returns null for anything else (names, @hourly, and so on).
 */
export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dowRaw = parseField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => d % 7));
  return { minute, hour, dom, month, dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

/**
 * The first cron match strictly after `after` (epoch ms), or null within 8 days.
 *
 * Cron is local time, but on this machine Node misreads the Windows time zone
 * (it reported GMT-8 for a GMT-7 clock), so callers pass the real UTC offset
 * in minutes from `paint.exe --utc-offset`. The default is Node's own guess.
 */
export function nextCronMatch(expr, after, offsetMin = -new Date(after).getTimezoneOffset()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!c) return null;
  const shift = offsetMin * MINUTE;
  // Walk wall-clock minutes as UTC fields of (time + offset).
  const d = new Date(Math.floor((after + shift) / MINUTE) * MINUTE + MINUTE);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    // Standard cron: when both day fields are restricted, either may match.
    const domOk = c.dom.has(d.getUTCDate());
    const dowOk = c.dow.has(d.getUTCDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (dayOk && c.month.has(d.getUTCMonth() + 1) && c.hour.has(d.getUTCHours()) && c.minute.has(d.getUTCMinutes())) {
      return d.getTime() - shift;
    }
    d.setTime(d.getTime() + MINUTE);
  }
  return null;
}

/**
 * How late a run may land before it counts as missed. Claude Code shifts a
 * recurring job by up to half its period (at most 30 minutes); the reported
 * nextFireAt already includes the shift, but recomputed runs don't.
 */
export function allowanceMs(item) {
  if (item.kind !== 'cron' || !item.recurring) return GRACE_MS;
  // Measure between two real runs: dueAt carries the scheduler's shift.
  const first = nextCronMatch(item.cron, item.dueAt, item.offsetMin);
  const second = first && nextCronMatch(item.cron, first, item.offsetMin);
  const period = second ? second - first : 60 * MINUTE;
  return Math.min(period / 2, 30 * MINUTE) + GRACE_MS;
}

/**
 * Advances a scheduled entry past `now`: a recurring cron moves to its next
 * run; anything else returns null (done). Used both when a run fires and when
 * one was missed.
 */
export function advance(item, now) {
  if (item.kind !== 'cron' || !item.recurring) return null;
  const dueAt = nextCronMatch(item.cron, now, item.offsetMin);
  return dueAt ? { ...item, dueAt } : null;
}

/** True when this scheduled entry should keep the pane working right now. */
export function scheduleHoldsTint(item, now) {
  return item.dueAt - now <= SCHEDULE_HORIZON_MS;
}

/** Whether a prompt is the one this scheduled entry enqueues. */
export function promptMatches(item, prompt) {
  const want = String(item.prompt || '').trim();
  return want.length > 0 && String(prompt || '').trim().startsWith(want);
}

// Stored prompts are capped; matching is by prefix.
export const PROMPT_KEEP = 500;
