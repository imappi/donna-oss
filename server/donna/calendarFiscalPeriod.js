// Calendar-period projection, not a statutory calendar mandate. Country contracts
// explicitly opt into their established calendar behavior; this is never a fallback country.
export const calendarFiscalPeriod = ({ date, incorporationDate = null } = {}) => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('resolveFiscalYearForEntity: date must be YYYY-MM-DD'), { statusCode: 409, code: 'TILIKAUSI_BAD_DATE' });
  }
  const year = date.slice(0, 4);
  const jan1 = `${year}-01-01`;
  const starts_on = typeof incorporationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(incorporationDate)
    && incorporationDate.slice(0, 4) === year && incorporationDate > jan1 ? incorporationDate : jan1;
  return { label: year, starts_on, ends_on: `${year}-12-31` };
};
