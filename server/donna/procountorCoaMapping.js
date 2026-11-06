// Donna (Donna's canonical chart) → Procountor Finnish statutory chart.
//
// Why this exists: the "provision the chart IN" mechanism Xero uses
// (xeroCoaProvisioning.DONNA_COA_ACCOUNTS pushed via provisionChartOfAccounts)
// is IMPOSSIBLE for Procountor — its chart of accounts is read-only over the
// API (POST /api/coa → 405 Method Not Allowed, POST /api/ledgeraccounts → 404,
// verified live 2026-07-09) and it is the Finnish statutory chart
// (Kirjanpitolautakunta liikekaava), whose codes/names never coincide with
// Donna's US-style ones. So instead of pushing Donna's chart into Procountor,
// writeback maps each ledger line's Donna account code INTO the standard Finnish
// chart through this static correspondence. This is the inline analog of the
// Xero constant: a canonical chart mapping kept in code, not a runtime subsystem.
//
// Target codes verified against the pilot client's synced chart (the 294-row procountor_accounts
// pulled by reference sync) on 2026-07-09. Kari's call (2026-07-09): "align with
// the Finnish model when using the Finnish accounting system."
//
// Rows tagged ASSUMPTION are Finnish-model defaults chosen without an explicit
// per-line confirmation. Because a Procountor export lands as an UNFINISHED
// ledger-receipt draft the firm verifies before booking, a wrong target surfaces
// at verification rather than silently hitting the official ledger — correct the
// mapping here when confirmed. Any Donna code NOT in this map (and not already a
// Finnish code / name match) fails writeback loudly rather than guessing.
export const DONNA_TO_PROCOUNTOR_LEDGER = {
  '201': '3000',    // Sales income → Sales (Myynti)
  '403': '7800',    // Travel → Travel expenses (Matkakulut)
  '494': '7800',    // Travel – International → Travel expenses (no separate intl account in the FI chart)
  '405': '7950',    // Meals and entertainment → Entertainment costs (Edustuskulut)
  '407': '8650',    // Office operations → Office and negotiation costs
  '850': '1777',    // Suspense → Clearing account            [ASSUMPTION: vs 1990 Payments in transit]
  '878': '2900',    // Intercompany clearing → Amounts owed to group member companies  [ASSUMPTION: payable side, per Donna's CURRLIAB typing; receivable side is 1730]
  '970': '2000',    // Owner A Share Capital → Subscribed capital (Osakepääoma)  [ASSUMPTION: the pilot client is an Oy; a partnership would be 2150 Capital input, partner A]
  'AWX779': '1920'  // Airwallex EUR → Cash at bank, bank 2   [ASSUMPTION: Nordea (the synced bank) is the 1910 primary slot]
};
