// A reversible representation change only: retain every value, row, field and
// ordering while writing common object keys once. Trusted source/writer objects
// are never changed. This is not a token estimator or an evidence filter.
export const JEV_TABLE_REPRESENTATION = 'Tables marked $table have columns and rows. Each row supplies the columns in order; its final object contains additional named fields to merge into that row. Objects marked $record supply values in the field order declared by that handle in prompt_records. Expand nested records and tables using the same rules. A refund_group_ref points to the complete receipt in prompt_refund_groups. No records or source values are omitted.';
export function compactJevPromptTables(value) {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compactJevPromptTables(v)]));
  const rows=value.map(compactJevPromptTables);
  if(rows.length<3 || !rows.every(row=>row && typeof row==='object' && !Array.isArray(row))) return rows;
  const columns=Object.keys(rows[0]).filter(key=>rows.every(row=>Object.hasOwn(row,key)));
  if(columns.length<2) return rows;
  const keys=new Set(columns);
  const table={$table:true,columns,rows:rows.map(row=>[
    ...columns.map(key=>row[key]),Object.fromEntries(Object.entries(row).filter(([key])=>!keys.has(key)))
  ])};
  return JSON.stringify(table).length+128<JSON.stringify(rows).length ? table : rows;
}

// Group selection receipts recur on every member. Keep the complete receipt
// once, including its source components and explicit allocation convention.
export function compactJevRefundGroups(input) {
  const result=structuredClone(input), groups={}, handles=new Map();
  const visit=value=>{
    if(!value || typeof value!=='object')return;
    for(const [key,item] of Object.entries(value)) {
      if((key==='refund_group' || key==='jev_refund_group') && item && typeof item==='object') {
        const serialized=JSON.stringify(item);
        let handle=handles.get(serialized);
        if(!handle) {handle=`refund_group_${handles.size+1}`;handles.set(serialized,handle);groups[handle]=item;}
        value[key]={refund_group_ref:handle};
      } else visit(item);
    }
  };
  visit(result);
  return handles.size ? {...result,prompt_refund_groups:groups} : result;
}

// Table cells can themselves contain many identically shaped source records.
// Share only their field names; every value and its order remain verbatim.
// This is reversible representation, never source selection or summarization.
export function compactJevPromptRecords(input) {
  const counts=new Map();let reserved=false;
  const visit=value=>{
    if(!value || typeof value!=='object')return;
    if(!Array.isArray(value)){
      if(Object.hasOwn(value,'$record') || Object.hasOwn(value,'prompt_records'))reserved=true;
      // JSON omits undefined object fields but turns undefined array cells
      // into null. Keep such objects in object form so the wire stays honest.
      if(value!==input && !value.$table && !Object.values(value).includes(undefined)){
        const shape=JSON.stringify(Object.keys(value));counts.set(shape,(counts.get(shape)||0)+1);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(input);
  if(reserved)return input;
  const selected=[...counts].filter(([shape,count])=>JSON.parse(shape).length>=3 && count>=2
    && (shape.length-30)*count>shape.length+100);
  if(!selected.length)return input;
  const handles=new Map(selected.map(([shape],i)=>[shape,`record_${i+1}`]));
  const encode=value=>{
    if(!value || typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(encode);
    const handle=value!==input && !value.$table && !Object.values(value).includes(undefined)
      ? handles.get(JSON.stringify(Object.keys(value))) : null;
    return handle?{$record:handle,values:Object.values(value).map(encode)}
      :Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]));
  };
  const encoded={...encode(input),prompt_records:Object.fromEntries(selected.map(([shape],i)=>[`record_${i+1}`,JSON.parse(shape)]))};
  return JSON.stringify(encoded).length+128<JSON.stringify(input).length?encoded:input;
}
