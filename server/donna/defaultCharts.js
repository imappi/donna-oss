// Which markets ship a Donna-NATIVE coded default chart (gb/defaultChart.js
// today), as opposed to the pack palette that every market declares.
//
// The two are different things and the chart plane must not confuse them:
//   - the pack PALETTE (packs/<id>/manifest.json chart_of_accounts) is the
//     coder's fallback MENU — names + canonical roles, no codes;
//   - a DEFAULT CHART is a coded, typed, role-annotated chart Donna seeds into
//     an empty ledger at provisioning, and the entity certificate pins it as
//     the client's persisted-chart CONTRACT (entityCertificateB.js
//     'gb_default_chart.v1': the persisted rows must equal it exactly, every
//     row coded).
// A market WITH a default chart takes its chart from there; palette-only
// names mint code-less at first posting, which that certificate explicitly
// sanctions. A market WITHOUT one (ae, fi, us) has nothing to seed the chart
// from except its palette — that is what firmDb.seedPackPaletteChartWithClient
// does, and this registry is how it knows to stand aside. Registered here,
// in one place, so a future market's default chart is one line and the seed
// never has to learn a country's name.

import { resolveProvisioningPolicy } from './provisioningPolicyRegistry.js';


export const marketHasNativeDefaultChart = (jurisdiction) =>
  Boolean(resolveProvisioningPolicy(jurisdiction)?.defaultChart);

// The CODED chart a new, empty book of this market and legal form is born
// with (FI-21: the Finnish Oy tilikartta), as opposed to a defaultChart above:
// it binds each row to the pack-palette name the coder uses, so the palette
// stays the menu while the book carries codes. Only an explicit new-book seed
// asks for it; existing books keep their palette chart. null = no birth chart.
export const marketBirthChart = (jurisdiction, entityType) =>
  resolveProvisioningPolicy(jurisdiction)?.birthChart?.({ entityType }) || null;
