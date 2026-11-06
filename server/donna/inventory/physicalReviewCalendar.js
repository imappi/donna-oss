import { toUtcIsoDay } from '../dates.js';

// A recorded service calendar, never an inferred jurisdiction or holiday list.
export function physicalReviewDeadline({ asOf, businessDays, calendar }) {
  if (!calendar?.timeZone || !Array.isArray(calendar.workingDays) || !calendar.workingDays.length
      || calendar.workingDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)
      || !Array.isArray(calendar.holidays) || calendar.holidays.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d))
      || !Number.isInteger(businessDays) || businessDays < 1 || businessDays > 5 || !Number.isFinite(Date.parse(asOf))) {
    throw Object.assign(new Error('A recorded working calendar and deadline basis are required.'), { code: 'PHYSICAL_REVIEW_CALENDAR_INVALID' });
  }
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: calendar.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = instant => Object.fromEntries(format.formatToParts(new Date(instant)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const start = parts(Date.parse(asOf));
  let day = new Date(Date.UTC(+start.year, +start.month - 1, +start.day));
  let remaining = businessDays;
  for (let n = 0; remaining && n < 366; n++) {
    day = new Date(day.getTime() + 86400000);
    if (calendar.workingDays.includes(day.getUTCDay()) && !calendar.holidays.includes(toUtcIsoDay(day))) remaining--;
  }
  if (remaining) throw new Error('Physical review calendar has no bounded working deadline.');
  // End of selected local service day; fixed point handles DST without
  // assuming every local day is 24 hours. No device-provided timezone.
  const wall = day.getTime() + 86399000;
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const p = parts(instant);
    const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const delta = wall - actual;
    instant += delta;
    if (!delta) return new Date(instant).toISOString();
  }
  throw new Error('Physical review deadline could not resolve in the configured timezone.');
}
