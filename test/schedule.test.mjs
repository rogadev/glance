import test from 'node:test';
import assert from 'node:assert/strict';
import { nextCronMatch, parseCron, allowanceMs, advance, SCHEDULE_HORIZON_MS } from '../schedule.mjs';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('nextCronMatch handles steps, ranges, lists, and pinned one-shots (local time)', () => {
  const t = at(2026, 11, 7, 11, 26);
  assert.equal(nextCronMatch('*/5 * * * *', t), at(2026, 11, 7, 11, 30));
  assert.equal(nextCronMatch('7 * * * *', t), at(2026, 11, 7, 12, 7));
  assert.equal(nextCronMatch('29 11 7 11 *', t), at(2026, 11, 7, 11, 29));
  assert.equal(nextCronMatch('0 9 * * 1-5', t), at(2026, 11, 9, 9, 0)); // Saturday -> Monday
  assert.equal(nextCronMatch('15,45 10-12 * * *', t), at(2026, 11, 7, 11, 45));
});

test('nextCronMatch is strictly after the given time', () => {
  const t = at(2026, 11, 7, 11, 30);
  assert.equal(nextCronMatch('*/5 * * * *', t), at(2026, 11, 7, 11, 35));
});

test('day-of-month and day-of-week both restricted match either (standard cron)', () => {
  // The 13th, or any Friday: from Sat Nov 7, Friday Nov 13 is both.
  assert.equal(nextCronMatch('0 0 13 * 5', at(2026, 11, 7, 0, 0)), at(2026, 11, 13, 0, 0));
  assert.equal(nextCronMatch('0 0 1 * 0', at(2026, 11, 7, 0, 0)), at(2026, 11, 8, 0, 0)); // Sunday first
});

test('parseCron rejects what it does not support', () => {
  for (const bad of ['@hourly', '* * * *', '0 9 * * MON', '60 * * * *', '*/0 * * * *']) assert.equal(parseCron(bad), null, bad);
});

test('a recurring cron advances to its next run; one-shots and wakeups end', () => {
  const t = at(2026, 11, 7, 11, 30);
  assert.equal(advance({ kind: 'cron', recurring: true, cron: '*/5 * * * *', dueAt: t }, t).dueAt, at(2026, 11, 7, 11, 35));
  assert.equal(advance({ kind: 'cron', recurring: false, cron: '30 11 7 11 *', dueAt: t }, t), null);
  assert.equal(advance({ kind: 'wakeup', dueAt: t }, t), null);
});

test('recurring jobs get up to half their period (max 30 min) of lateness, plus grace', () => {
  const t = at(2026, 11, 7, 11, 30);
  assert.equal(allowanceMs({ kind: 'cron', recurring: true, cron: '*/10 * * * *', dueAt: t }), 5 * 60_000 + 120_000);
  assert.equal(allowanceMs({ kind: 'cron', recurring: true, cron: '7 * * * *', dueAt: t }), 30 * 60_000 + 120_000);
  assert.equal(allowanceMs({ kind: 'wakeup', dueAt: t }), 120_000);
  assert.ok(SCHEDULE_HORIZON_MS === 60 * 60_000);
});

test('an explicit UTC offset overrides Node: this machine is UTC-7, Node guessed UTC-8', () => {
  // CronCreate reported nextFireAt 1794076140000 (18:29Z) for "29 11 7 11 *" on 2026-11-07.
  const madeAt = Date.UTC(2026, 10, 7, 18, 26);
  assert.equal(nextCronMatch('29 11 7 11 *', madeAt, -420), 1794076140000);
  assert.equal(nextCronMatch('*/5 * * * *', Date.UTC(2026, 10, 7, 18, 31), -420), Date.UTC(2026, 10, 7, 18, 35));
  // Weekday 9am local is 16:00Z at UTC-7; Saturday the 7th rolls to Monday the 9th.
  assert.equal(nextCronMatch('0 9 * * 1-5', madeAt, -420), Date.UTC(2026, 10, 9, 16, 0));
});
