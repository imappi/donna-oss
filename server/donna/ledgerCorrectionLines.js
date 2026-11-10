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


// What a correction moves per tax code: the reversal plus the replacement
// lines, netted by tax code and currency (debit minus credit). A line with no
// tax code, or with the ledger's 'NONE' placeholder (db/ledger.js writes it
// where a line has none), moves no tax code. [] when every tax code nets to zero. Sorted, so
// the same correction always reads the same (it is digested for the
// acknowledgement of a filed VAT return, db/ledger.js).
export function correctionTaxMovement(lines = []) {
  const moved = new Map();
  for (const line of lines) {
    const taxType = String(line.account?.tax_type || line.tax_type || '').trim();
    if (!taxType || taxType.toUpperCase() === 'NONE') continue;
    const currency = String(line.currency || '').trim().toUpperCase();
    const key = JSON.stringify([taxType, currency]);
    moved.set(key, (moved.get(key) || 0) + Math.round((Number(line.debit || 0) - Number(line.credit || 0)) * 100));
  }
  return [...moved.entries()].filter(([, cents]) => cents)
    .map(([key, cents]) => { const [tax_type, currency] = JSON.parse(key); return { tax_type, currency, amount: cents / 100 }; })
    .sort((a, b) => a.tax_type.localeCompare(b.tax_type) || a.currency.localeCompare(b.currency));
}
