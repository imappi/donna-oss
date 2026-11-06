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

