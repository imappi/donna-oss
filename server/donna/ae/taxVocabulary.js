// Country-owned coding vocabulary. Existing treatment labels and guidance;
// tax registration is supplied separately and never inferred from jurisdiction.
export const AE_VAT_TAX_VOCABULARY = 'ae_vat';

export const AE_VAT_TAX_TREATMENT_OPTIONS = [
  'VAT 5% (standard rated)',
  'Zero-rated supply',
  'Exempt supply',
  'Out of scope of UAE VAT',
  'Reverse charge (RCM)',
  'UAE VAT check'
];

export const AE_VAT_INSTRUCTIONS_NOTE = `The applicable jurisdiction is the United Arab Emirates; the tax_treatment options are UAE VAT treatments. Pick the treatment the line's substance supports: 'VAT 5% (standard rated)' for most goods and services supplied in the UAE; 'Zero-rated supply' only where zero-rating genuinely applies (exports of goods and services outside the GCC implementing states, international transport, the first supply of new residential buildings, certain education and healthcare supplies, investment-grade precious metals); 'Exempt supply' for exempt activities (certain financial services, residential leases after the first supply, bare land, local passenger transport); 'Out of scope of UAE VAT' for wages, dividends, taxes, and internal transfers/equity/capital movements; 'Reverse charge (RCM)' where the customer accounts for the VAT (imports of services or goods from outside the UAE under the reverse-charge mechanism). When you genuinely cannot determine the treatment, answer 'UAE VAT check' — it flags the line for review instead of guessing a rate. A bank payment to the Federal Tax Authority that settles the client's VAT return is NOT an expense — it clears the VAT liability the return already reported; treat it as 'Out of scope of UAE VAT'. An FTA payment that is clearly corporate tax is likewise 'Out of scope of UAE VAT', coded by its own substance. Designated-zone and free-zone supply rules are nuanced — when zone status makes the treatment genuinely uncertain, answer 'UAE VAT check' rather than assuming. Two traps seen on real UAE books: (1) a NON-RESIDENT supplier that is itself registered for UAE VAT and charges 5% on its invoice — most consumer digital-service platforms (streaming, app stores, ride-hailing, delivery apps) do — is 'VAT 5% (standard rated)', NOT 'Reverse charge (RCM)'; reserve RCM for an imported service whose invoice shows NO UAE VAT, and when the invoice is on file read it rather than defaulting either way. (2) Public passenger transport fares — Nol card top-ups, metro, bus, taxi — are 'Exempt supply' (local passenger transport), and fines and penalties (FTA administrative penalties, traffic fines) are 'Out of scope of UAE VAT' and belong in a fines-and-penalties account, never in statutory fees.`;

export const TAX_VOCABULARY = Object.freeze({
    marker: AE_VAT_TAX_VOCABULARY,
    jurisdiction: 'ae',
    label: 'United Arab Emirates VAT',
    options: AE_VAT_TAX_TREATMENT_OPTIONS,
    unsureMarker: 'UAE VAT check',
    outOfScope: 'Out of scope of UAE VAT',
    instructionsNote: AE_VAT_INSTRUCTIONS_NOTE
  });
