// Independent economic oracle; never imported by the runtime worker or provider fixture.
export const AE_MONTH_EXPECTED = Object.freeze({
  currency:'AED',periodStart:'2026-09-01',periodEnd:'2026-09-30',
  bank:10735,revenue:1000,operatingSupplies:300,vatPayable:35,shareCapital:10000,profit:700,
  trialBalanceDebit:11035,trialBalanceCredit:11035,
  vat:{supplies:1000,output:50,expenses:300,input:15,net:35},
  sourceMatches:[{key:'sale',date:'2026-09-09',amount:1050},{key:'supplies',date:'2026-09-12',amount:210},{key:'purpose',date:'2026-09-21',amount:105}],
});
