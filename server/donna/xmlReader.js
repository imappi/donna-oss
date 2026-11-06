// Shared dependency-free XML tree reader used by structured invoice adapters.
// Moved without behavior changes from the FI receive adapter in JN-04.
// Country-specific validation, amount/date normalization and schema interpretation
// stay in their adapters. This is the existing limited reader, not a full XML or
// namespace validator; callers own their format and resource-limit contracts.

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// ---------------------------------------------------------------------------------
// Minimal dependency-free XML reader (scoped to well-formed Finvoice/UBL).
// ---------------------------------------------------------------------------------
// Produces a tree of { name, localName, attrs, children, text }. `localName` strips
// any namespace prefix (UBL uses cbc:/cac:), so extraction can key off local names
// while navigating by path. Throws on malformed/unbalanced input — the caller turns
// that into an escalation, never a silent partial parse.
const decodeEntities = (s) =>
  String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ent] ?? m;
  });

const parseAttrs = (raw) => {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return attrs;
};

const mkNode = (name, attrs) => {
  const localName = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  return { name, localName, attrs: attrs || {}, children: [], text: '' };
};

export const parseXml = (xml) => {
  if (!isNonEmptyString(xml)) {
    const e = new Error('empty XML'); e.code = 'XML_EMPTY'; throw e;
  }
  let s = String(xml).replace(/^﻿/, '');
  // Strip declarations/PIs, comments, and DOCTYPE (no internal-subset support needed).
  s = s.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');

  const doc = mkNode('#document');
  const stack = [doc];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) {
      const text = s.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].text += decodeEntities(text);
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt);
      if (end === -1) { const e = new Error('unterminated CDATA'); e.code = 'XML_CDATA'; throw e; }
      stack[stack.length - 1].text += s.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    const gt = s.indexOf('>', lt);
    if (gt === -1) { const e = new Error('unterminated tag'); e.code = 'XML_TAG'; throw e; }
    const tag = s.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const top = stack[stack.length - 1];
      if (stack.length < 2 || top.name !== name) {
        const e = new Error(`unbalanced closing tag </${name}>`); e.code = 'XML_UNBALANCED'; throw e;
      }
      stack.pop();
    } else {
      const selfClose = tag.endsWith('/');
      const body = (selfClose ? tag.slice(0, -1) : tag).trim();
      const sp = body.search(/\s/);
      const name = sp === -1 ? body : body.slice(0, sp);
      const node = mkNode(name, sp === -1 ? {} : parseAttrs(body.slice(sp + 1)));
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
  }
  if (stack.length !== 1) { const e = new Error('unclosed element'); e.code = 'XML_UNCLOSED'; throw e; }
  const root = doc.children.find((c) => c.name && c.name[0] !== '#');
  if (!root) { const e = new Error('no root element'); e.code = 'XML_NOROOT'; throw e; }
  return root;
};
