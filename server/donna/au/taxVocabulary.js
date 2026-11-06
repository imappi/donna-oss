// Country-owned coding vocabulary. Existing treatment labels and guidance;
// tax registration is supplied separately and never inferred from jurisdiction.
export const AU_GST_TAX_VOCABULARY = 'au_gst';

export const AU_GST_TAX_TREATMENT_OPTIONS = [
  'GST 10%',
  'GST Free',
  'Input Taxed',
  'BAS Excluded',
  'GST check'
];

export const AU_GST_INSTRUCTIONS_NOTE = `The applicable jurisdiction is Australia; the tax_treatment options are Australian GST treatments. Pick the treatment the line's substance supports: 'GST 10%' for standard taxable sales and purchases; 'GST Free' only where the supply is genuinely GST-free (most basic food, health, education, exports); 'Input Taxed' for input-taxed supplies (financial supplies, residential rent); 'BAS Excluded' for amounts outside the GST system (wages and superannuation, dividends, taxes, internal transfers/equity/capital movements). When you genuinely cannot determine the treatment, answer 'GST check' — it flags the line for review instead of guessing a rate. A bank payment to the ATO that settles the client's BAS (GST, PAYG) is NOT an expense — it clears the liability the BAS already reported; treat it as 'BAS Excluded'.`;

export const TAX_VOCABULARY = Object.freeze({
    marker: AU_GST_TAX_VOCABULARY,
    jurisdiction: 'au',
    label: 'Australia GST',
    options: AU_GST_TAX_TREATMENT_OPTIONS,
    unsureMarker: 'GST check',
    outOfScope: 'BAS Excluded',
    instructionsNote: AU_GST_INSTRUCTIONS_NOTE
  });
