// Country-owned coding vocabulary. Existing treatment labels and guidance;
// tax registration is supplied separately and never inferred from jurisdiction.
export const GB_VAT_TAX_VOCABULARY = 'gb_vat';

export const GB_VAT_TAX_TREATMENT_OPTIONS = [
  'VAT 20%',
  'VAT 5%',
  'Zero-rated 0%',
  'VAT exempt',
  'Outside the scope of VAT',
  'Reverse charge',
  // IV-2 (design-donna-gb-input-vat-boxes-4-7.md §3): both existed as posting
  // codes with no expressible verdict. 'VAT blocked (no reclaim)' is a
  // pre-staging requirement — without it 'VAT 20%' is the only expressible
  // verdict for entertainment/car purchases, a wrong-reclaim path.
  'EU acquisition',
  'VAT blocked (no reclaim)',
  // A business that is not VAT-registered on the line's date charges and
  // reclaims no VAT: the line posts gross with no VAT code. Only for that
  // business; the posting policy refuses it unless the registration record
  // says not registered on the date (gb/postingPolicy.js).
  'No VAT (not VAT-registered)',
  'VAT check'
];

export const GB_VAT_INSTRUCTIONS_NOTE = `The applicable jurisdiction is the United Kingdom; the tax_treatment options are UK VAT treatments. Pick the treatment the line's substance supports: 'VAT 20%' (standard rate) for most goods and services; 'VAT 5%' only where the reduced rate genuinely applies (domestic fuel and power, energy-saving installations, children's car seats); 'Zero-rated 0%' for zero-rated supplies (most food, books and publications, children's clothing, passenger transport, exports of goods); 'VAT exempt' for exempt activities (financial services, insurance, education, health, postage); 'Outside the scope of VAT' for wages, dividends, taxes, and internal transfers/equity/capital movements; 'Reverse charge' where the customer accounts for the VAT (services purchased from overseas suppliers, the domestic reverse charge for construction services). 'No VAT (not VAT-registered)' only when the line's tax_registration says the business is not VAT-registered on its date, and then for every purchase and sale of that date. When you genuinely cannot determine the treatment, answer 'VAT check' — it flags the line for review instead of guessing a rate. A bank payment to HMRC that settles the client's VAT return is NOT an expense — it clears the VAT liability the return already reported; treat it as 'Outside the scope of VAT'. An HMRC payment that is clearly a different tax (PAYE/NIC, corporation tax) is likewise 'Outside the scope of VAT', coded by its own substance.`;

export const TAX_VOCABULARY = Object.freeze({
    marker: GB_VAT_TAX_VOCABULARY,
    jurisdiction: 'gb',
    label: 'United Kingdom VAT',
    options: GB_VAT_TAX_TREATMENT_OPTIONS,
    unsureMarker: 'VAT check',
    outOfScope: 'Outside the scope of VAT',
    instructionsNote: GB_VAT_INSTRUCTIONS_NOTE
  });
