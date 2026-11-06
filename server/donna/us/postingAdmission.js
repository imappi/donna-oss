// US posting admission: gross-only books (us/postingPolicy.js has no tax
// splitting). A line the coder marks 'Sales tax collected' would post whole
// into revenue, so a would-be auto-post of that treatment becomes an owner
// ask for the sales record (gross sales and the tax collected) instead.
// Narrows only: every other verdict is returned unchanged; never writes.
const SALES_TAX_COLLECTED = 'Sales tax collected';

export const US_POSTING_ADMISSION = Object.freeze({
  codingAutoPostVerdict({ verdict, suggestion = {} }) {
    if (verdict?.action !== 'auto_post') return verdict;
    return String(suggestion.tax_treatment || '').trim() === SALES_TAX_COLLECTED
      ? { action: 'owner_ask', reason: 'revenue_source_required', blockers: ['us_sales_tax_collected_gross_only'] }
      : verdict;
  }
});
