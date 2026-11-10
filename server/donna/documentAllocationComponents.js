// Source arithmetic shared by the menu, recovery guard and existing writer.
// It neither retrieves evidence nor chooses an accounting treatment.
const cents = value => Math.round(Number(value) * 100);
const money = value => value / 100;
const finite = value => value != null && Number.isFinite(Number(value));
const sourceRate = line => {
  const raw = line.raw_extraction || line.payload?.raw_extraction || {};
  const value = line.tax_rate ?? raw.tax_rate;
  if (!finite(value)) return null;
  return Math.round((Number(value) > 0 && Number(value) <= 1 ? Number(value) * 100 : Number(value)) * 1e6) / 1e6;
};
export function documentSourceComponents(document) {
  const lines = document?.lines;
  const incomplete = reason => ({ complete: false, reason, components: [] });
  if (!Array.isArray(lines) || !lines.length || document.coverage?.lines_truncated) return incomplete('source_components_incomplete');
  const summary = document.parse_summary || {};
  const headerTax = finite(document.tax_amount) ? cents(document.tax_amount) : null;
  const total = cents(document.total_amount);
  if (!(total > 0) || lines.some(line => !finite(line.amount) || Number(line.amount) <= 0)) return incomplete('signed_or_missing_source_components');
  const lineSum = lines.reduce((sum, line) => sum + cents(line.amount), 0);
  const declared = summary.line_amounts_include_tax ?? summary.totals_validation?.inferred_line_amounts_include_tax;
  const inclusive = typeof declared === 'boolean' ? declared
    : lineSum === total ? true : headerTax != null && lineSum + headerTax === total ? false : null;
  if (inclusive == null) return incomplete('source_amount_basis_unknown');
  const components = lines.map((line, index) => {
    const raw = line.raw_extraction || line.payload?.raw_extraction || {};
    const rate = sourceRate(line);
    const tax = line.tax_amount ?? raw.tax_amount;
    return { line_handle: `line_${index + 1}`, document_line_id: line.id,
      description: line.description || '', amount: cents(line.amount), rate,
      source_tax: finite(tax) ? cents(tax) : null };
  });
  // A one-line net invoice carries its tax in the header in older extractions.
  if (components.length === 1 && components[0].source_tax == null && headerTax != null) components[0].source_tax = headerTax;
  const taxComplete = components.every(line => line.rate != null || line.source_tax != null || headerTax === 0);
  // Net components that already equal the paid total need no invented tax
  // amount. Tax entitlement remains unknown and must be selected separately.
  if (!taxComplete && !inclusive && lineSum !== total) return incomplete('source_component_tax_missing');
  for (const component of components) component.source_tax_known = component.rate != null || component.source_tax != null || headerTax === 0;
  const groups = new Map();
  for (const component of components) {
    const key = component.rate ?? 'header';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(component);
  }
  for (const [rate, group] of groups) {
    // Round by the printed tax group, not each grocery item independently.
    const sum = group.reduce((value, line) => value + line.amount, 0);
    const groupTax = rate === 'header' ? group.reduce((value, line) => value + (line.source_tax || 0), 0)
      : Math.round(inclusive ? sum * Number(rate) / (100 + Number(rate)) : sum * Number(rate) / 100);
    let cumulative = 0, assigned = 0;
    for (const line of group) {
      cumulative += line.amount;
      const calculated = Math.round(groupTax * cumulative / sum) - assigned;
      const tax = line.source_tax ?? calculated;
      assigned += tax;
      line.source_tax = tax;
      line.gross = inclusive ? line.amount : line.amount + tax;
      line.net = line.gross - tax;
    }
  }
  const taxSum = components.reduce((sum, line) => sum + line.source_tax, 0);
  const grossSum = components.reduce((sum, line) => sum + line.gross, 0);
  if (grossSum !== total || (headerTax != null && Math.abs(taxSum - headerTax) > 2)) return incomplete('source_components_do_not_foot');
  // The printed header is authoritative within ordinary cent rounding.
  if (headerTax != null && taxSum !== headerTax) {
    const last = [...components].reverse().find(line => line.source_tax > 0);
    if (!last) return incomplete('source_components_do_not_foot');
    last.source_tax += headerTax - taxSum;
    last.net = last.gross - last.source_tax;
  }
  if (components.some(line => line.net < 0 || line.source_tax < 0)) return incomplete('source_components_do_not_foot');
  return { complete: true, tax_complete: taxComplete, basis: inclusive ? 'tax_inclusive' : 'tax_exclusive',
    total: money(total), source_tax: taxComplete ? money(headerTax ?? taxSum) : null,
    components: components.map(line => ({ ...line, amount: money(line.amount), gross: money(line.gross), net: money(line.net), source_tax: money(line.source_tax) })) };
}

// What the business's OWN sales document prints as tax, when it prints any:
// a settled sales invoice or issued receipt (codingRevenueEvidence.js
// settledSalesEvidence, without the processor's payout statement, which is
// not the business's own document) whose header tax is above zero or one of
// whose lines carries a rate or a tax amount above zero (read as
// sourceRate and documentSourceComponents read them). Arithmetic over what is
// printed: it never says whether that tax is right, owed or reportable.
// null when the document is not such a source or prints no tax.
export function salesSourcePrintedTax(document) {
  if (!document || !['confirmed', 'auto_matched'].includes(document.match_status)
    || !['sales_invoice', 'issued_receipt'].includes(document.document_type)) return null;
  const header = finite(document.tax_amount) && Number(document.tax_amount) > 0 ? Number(document.tax_amount) : null;
  const lines = Array.isArray(document.lines) ? document.lines : [];
  const lineTax = line => line.tax_amount ?? line.raw_extraction?.tax_amount ?? line.payload?.raw_extraction?.tax_amount;
  const rated = lines.filter(line => (sourceRate(line) ?? 0) > 0 || (finite(lineTax(line)) && Number(lineTax(line)) > 0));
  if (header == null && !rated.length) return null;
  return { document_id: document.document_id || document.id || null, document_type: document.document_type,
    filename: document.filename || '', document_date: document.document_date || null,
    total_amount: finite(document.total_amount) ? Number(document.total_amount) : null, currency: document.currency || '',
    tax_amount: header, rates: [...new Set(rated.map(sourceRate).filter(rate => rate > 0))] };
}

// A P&L account follows its matched source's side whatever the cash
// direction: a refund against a purchase source reverses that purchase and is
// never revenue; a refund against an issued sales invoice reverses that sale
// and is never an expense.
export const sourceSideAccountClassConflict = ({ documentType, accountClass }) =>
  (documentType === 'sales_invoice' && accountClass === 'expense')
  || (['supplier_bill', 'receipt'].includes(documentType) && accountClass === 'revenue');

// Positive ordinary invoice components follow the invoice issuer. Credit notes,
// purchase refunds and mixed/signed sources are outside this contract.
export const allocationAccountClassConflict = ({ documentType, incoming, outgoing, accountClass }) =>
  (documentType === 'sales_invoice' ? incoming > 0 && outgoing === 0 : outgoing > 0 && incoming === 0)
  && sourceSideAccountClassConflict({ documentType, accountClass });

// The verified-source shapes a document_discrepancy question may cite: the
// independent re-read receipt, the writer's own complete source validation
// carried by a reconsideration, or a held source whose printed components are
// complete. Nothing here judges the accounting; it only says what is in hand.
export function hasVerifiedSourceForDiscrepancy(transaction = {}) {
  const review = transaction.posting_recovery?.review || transaction.posting_recovery || null;
  if (review?.source_verified === true || review?.source_validation?.complete === true) return true;
  const document = transaction.matched_document;
  if (!document || !['confirmed', 'auto_matched'].includes(document.match_status)) return false;
  return documentSourceComponents(document).complete === true;
}

// Whether the verified source's PRINTED tax is complete and consistent — the
// fork between the two H-5a outcomes (Kari, 2026-09-24). With clear printed
// tax, an unsure treatment is Donna's failure, never an owner question; only
// an incomplete or inconsistent printed tax is a genuine source discrepancy.
// Arithmetic over what the source prints, read from the same three verified
// shapes as above; `ratesInForce` is the coding policy's dated rate set
// (taxRatesInForceFor; null when the date has no exact era, and then no rate
// is judged). It never picks a treatment.
export function sourceTaxClarity(transaction = {}, { ratesInForce = null } = {}) {
  const review = transaction.posting_recovery?.review || transaction.posting_recovery || null;
  const held = transaction.matched_document || {};
  const unclear = reason => ({ clear: false, reason });
  let total, tax, lines = null, components = null;
  if (review?.source_verified === true) {
    total = review.printed_header?.total_amount ?? held.total_amount;
    tax = review.printed_summary?.tax_amount;
    if (Array.isArray(review.printed_lines) && review.printed_lines.length) {
      lines = review.printed_lines;
      components = documentSourceComponents({ lines, total_amount: total, tax_amount: tax });
    }
  } else if (review?.source_validation?.complete === true) {
    components = review.source_validation;
    total = components.total; tax = components.source_tax;
    lines = components.components || [];
  } else {
    total = held.total_amount; tax = held.tax_amount;
    if (Array.isArray(held.lines) && held.lines.length) { lines = held.lines; components = documentSourceComponents(held); }
  }
  if (!finite(total) || !(Number(total) > 0) || !finite(tax)) return unclear('source_vat_amount_missing');
  // Zero printed VAT with no stated reason stays unclear, so it remains an owner
  // ask for the no-VAT note (Kari, 2026-09-24).
  if (!(Number(tax) > 0)) return unclear('source_prints_no_vat');
  if (Number(tax) >= Number(total)) return unclear('source_vat_exceeds_total');
  if (components && components.complete !== true) return unclear(components.reason || 'source_components_do_not_foot');
  const valid = Array.isArray(ratesInForce) ? ratesInForce.filter(rate => Number(rate) > 0).map(Number) : null;
  // A raw printed line carries tax_rate; a validated component its normalized rate.
  const printed = [...new Set((lines || []).map(line => sourceRate(line) ?? (finite(line.rate) ? Number(line.rate) : null)).filter(rate => rate != null))];
  const receipt = { clear: true, total: Number(total), tax: Number(tax) };
  if (printed.length) {
    if (valid && printed.some(rate => !valid.includes(rate))) return unclear('source_rate_not_in_force');
    return { ...receipt, rates: printed };
  }
  // No printed rate: the printed net and VAT must imply exactly one rate in force.
  if (!valid) return { ...receipt, rates: [] };
  const net = cents(total) - cents(tax);
  const implied = valid.filter(rate => Math.abs(Math.round(net * rate / 100) - cents(tax)) <= 2);
  if (implied.length !== 1) return unclear(implied.length ? 'source_rate_ambiguous' : 'source_vat_implies_no_rate_in_force');
  return { ...receipt, rates: implied, implied: true };
}
