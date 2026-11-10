// Pure account/component difference, shared by recovery and verification.
export function correctionDeltaLines(originalLines,targetLines) {
  const balances=new Map();
  const add=(line,sign)=>{
    const account=line.account || {};
    const shape={account_code:account.code || line.account_code || null,
      account_name:account.name || line.account_name,account_type:account.type || line.account_type || 'unknown',
      normal_balance:account.normal_balance || line.normal_balance || 'debit',
      tax_type:account.tax_type || line.tax_type || null,role:account.role || line.role || null,currency:line.currency};
    const key=JSON.stringify([shape.account_code || shape.account_name,shape.currency,shape.tax_type,shape.role]);
    const entry=balances.get(key) || {...shape,cents:0};
    entry.cents+=sign*Math.round((Number(line.debit || 0)-Number(line.credit || 0))*100);
    balances.set(key,entry);
  };
  originalLines.forEach(l=>add(l,-1));targetLines.forEach(l=>add(l,1));
  return [...balances.values()].filter(l=>l.cents).map(({cents,...l})=>({...l,
    debit:cents>0?cents/100:0,credit:cents<0?-cents/100:0,amount:Math.abs(cents)/100}));
}


// The line's tax code, when the country declares no return reader. The
// ledger's 'NONE' placeholder (db/ledger.js writes it where a line has none)
// is no code.
export const taxCodeReturnKey = (line = {}) => {
  const taxType = String(line.tax_type || '').trim();
  return taxType && taxType.toUpperCase() !== 'NONE' ? `tax_code:${taxType}` : null;
};

// What a journal's lines move in what a VAT return reads: the lines netted by
// the country's read key (taxRegistration.returnLineKey, else the tax code)
// and currency, debit minus credit. A line the return does not read (key
// null) moves nothing. [] when every key nets to zero. Sorted, so the same
// lines always read the same (it is digested for the acknowledgement of a
// filed VAT return, db/ledger.js).
export function correctionReturnMovement(lines = [], keyOf = taxCodeReturnKey) {
  const moved = new Map();
  for (const line of lines) {
    const account = line.account || {};
    const key = keyOf({ tax_type: account.tax_type || line.tax_type || null, role: account.role || line.role || null,
      account_code: account.code || line.account_code || null,
      account_type: (account.type && account.type !== 'unknown' ? account.type : null) || line.account_type || null });
    if (!key) continue;
    const currency = String(line.currency || '').trim().toUpperCase();
    const mapKey = JSON.stringify([key, currency]);
    moved.set(mapKey, (moved.get(mapKey) || 0) + Math.round((Number(line.debit || 0) - Number(line.credit || 0)) * 100));
  }
  return [...moved.entries()].filter(([, cents]) => cents)
    .map(([mapKey, cents]) => { const [key, currency] = JSON.parse(mapKey); return { key, currency, amount: cents / 100 }; })
    .sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency));
}
