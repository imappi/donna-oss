// Optional invoice display contract. Labels live in the country pack; facts
// come from the validated invoice snapshot. No rates or registration facts are
// inferred here, and packs without this contract keep their existing values.
import { formatPackAmount, formatPackDate } from './packs.js';
import { bidiIsolate, containsRtl, isolateLtr } from './bidiText.js';

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invoice statutory display requires ${field}`);
  }
  return value.trim();
};

const requiredAmount = (value, field) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
    throw new Error(`Invoice statutory display requires ${field}`);
  }
  return Number(value);
};

// A typed amount/TRN is one directional atom. The free-text identifier
// recognizer intentionally cannot infer localized numeric grouping, so do not
// feed a formatted monetary value through it (10,000.00 must stay whole).
const labelledValue = (labels, key, value) => {
  const label = `${requiredText(labels?.[key], key)}: `;
  return containsRtl(label) ? `${bidiIsolate(label)}${isolateLtr(value)}` : `${label}${value}`;
};

export const buildInvoiceTaxLineSuffix = ({ pack, line, currency, language }) => {
  const catalog = pack?.documents?.invoice_statutory_labels;
  if (!catalog || line?.taxAmount == null) return '';
  const labels = catalog[language];
  const tax = requiredAmount(line.taxAmount, 'line tax amount');
  const net = requiredAmount(line.net, 'line net amount');
  const payable = Math.round((net + tax) * 100) / 100;
  return `; ${labelledValue(labels, 'line_tax', `${formatPackAmount(pack, tax, language)} ${currency}`)}; ${labelledValue(labels, 'line_payable', `${formatPackAmount(pack, payable, language)} ${currency}`)}`;
};

export const buildInvoiceStatutoryValues = ({ pack, invoice, language }) => {
  const catalog = pack?.documents?.invoice_statutory_labels;
  if (!catalog) return {};
  const labels = catalog[language];
  if (!labels) throw new Error(`Invoice statutory display has no labels for ${language}`);
  const sellerRegistered = invoice?.seller?.taxRegistered;
  if (typeof sellerRegistered !== 'boolean') {
    throw new Error('Invoice statutory display requires resolved seller registration');
  }
  const values = {
    seller_address: requiredText(invoice?.seller?.address, 'seller address'),
    buyer_address: requiredText(invoice?.buyer?.address, 'buyer address'),
    supply_date: formatPackDate(pack, requiredText(invoice?.supplyDate, 'supply date'), language),
    seller_tax_registration_block: '',
    buyer_tax_registration_block: '',
    invoice_tax_totals_block: ''
  };
  if (!sellerRegistered) return values;
  const line = (key, value) => labelledValue(labels, key, value);
  values.seller_tax_registration_block = line('seller_tax_registration',
    requiredText(invoice.seller.taxRegistrationId, 'seller tax registration id'));
  if (typeof invoice?.buyer?.taxRegistered !== 'boolean') {
    throw new Error('Invoice statutory display requires resolved buyer registration');
  }
  if (invoice.buyer.taxRegistered) {
    values.buyer_tax_registration_block = line('buyer_tax_registration',
      requiredText(invoice.buyer.taxRegistrationId, 'buyer tax registration id'));
  }
  const currency = requiredText(invoice.currency, 'currency');
  values.invoice_tax_totals_block = [
    line('subtotal', `${formatPackAmount(pack, requiredAmount(invoice.subtotal, 'subtotal'), language)} ${currency}`),
    line('tax_total', `${formatPackAmount(pack, requiredAmount(invoice.taxTotal, 'tax total'), language)} ${currency}`)
  ].join('\n');
  return values;
};
