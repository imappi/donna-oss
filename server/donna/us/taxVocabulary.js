// Country-owned coding vocabulary. Existing treatment labels and guidance;
// tax registration is supplied separately and never inferred from jurisdiction.
export const US_SALES_TAX_VOCABULARY = 'us_sales_tax';

export const US_SALES_TAX_TREATMENT_OPTIONS = [
  'No sales tax',
  'Sales tax collected',
  'Out of scope',
  'Sales tax check'
];

export const US_SALES_INSTRUCTIONS_NOTE = `This client is a United States business; the US has no VAT or GST, so the tax_treatment options describe sales-tax character only. 'No sales tax' for most purchases and for sales that carry no sales tax — sales tax paid on a purchase is NOT recoverable: it stays part of the expense, never a separate tax asset. 'Sales tax collected' for a sale or deposit that includes sales tax the business collected and owes to a state or local tax authority. 'Out of scope' for wages, taxes, and internal transfers/equity/capital movements. When you genuinely cannot determine the treatment, answer 'Sales tax check' — it flags the line for review instead of guessing. A bank payment to a state tax authority remitting collected sales tax is NOT an expense — it clears the sales-tax liability; treat it as 'Out of scope'.`;

export const TAX_VOCABULARY = Object.freeze({
    marker: US_SALES_TAX_VOCABULARY,
    jurisdiction: 'us',
    label: 'United States sales tax',
    options: US_SALES_TAX_TREATMENT_OPTIONS,
    unsureMarker: 'Sales tax check',
    outOfScope: 'Out of scope',
    instructionsNote: US_SALES_INSTRUCTIONS_NOTE
  });
