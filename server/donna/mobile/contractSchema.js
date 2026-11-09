// The pinned mobile contract, as data, plus a deliberately small validator for
// the OpenAPI 3.1 / JSON Schema keywords the contract actually uses. It exists
// so conformance tests can check every implemented response against the
// contract without adding a schema-validation dependency. It is not used on the
// request path: the adapter does not validate its own output at runtime.
//
// Supported: $ref (local), type (string or array, incl. 'null'), enum, const,
// required, properties, additionalProperties (false | schema), items, oneOf,
// anyOf, allOf, minimum, maximum, exclusiveMinimum, minLength, maxLength,
// minItems, maxItems, format date / date-time / email. An unknown keyword is
// ignored, so `validateAgainst` refuses to vouch for a schema that uses a
// keyword outside this list (see UNSUPPORTED_KEYWORDS below).
import { readFileSync } from 'node:fs';

const CONTRACT_URL = new URL('./contract/mobile-api.json', import.meta.url);
export const MOBILE_CONTRACT = JSON.parse(readFileSync(CONTRACT_URL, 'utf8'));
export const MOBILE_CONTRACT_SOURCE = JSON.parse(readFileSync(new URL('./contract/SOURCE.json', import.meta.url), 'utf8'));

const SUPPORTED = new Set(['$ref', 'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
  'oneOf', 'anyOf', 'allOf', 'minimum', 'maximum', 'exclusiveMinimum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'format', 'description', 'deprecated', 'uniqueItems', 'pattern', 'default', 'summary']);

const resolveRef = (ref) => {
  if (!ref.startsWith('#/')) throw new Error(`Only local refs are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], MOBILE_CONTRACT);
};

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};
const typeMatches = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// RFC 3339 with an explicit offset (the contract's law: never a bare local time).
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export const validateAgainst = (value, schema, at = '$') => {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  for (const [key, keywordValue] of Object.entries(schema)) {
    // A null-valued stray key is a YAML flow-mapping artifact in the contract
    // (an unquoted comma inside `{ description: a, b }` makes `b` a key), not a
    // schema keyword; GAPS.md proposes quoting those descriptions upstream.
    if (keywordValue === null) continue;
    if (!SUPPORTED.has(key)) errors.push(`${at}: schema keyword '${key}' is not supported by the test validator`);
  }
  if (schema.$ref) return errors.concat(validateAgainst(value, resolveRef(schema.$ref), at));
  if (schema.allOf) for (const part of schema.allOf) errors.push(...validateAgainst(value, part, at));
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((part) => validateAgainst(value, part, at).length === 0).length;
    if (passing !== 1) errors.push(`${at}: matches ${passing} of oneOf (expected exactly 1)`);
  }
  if (schema.anyOf && !schema.anyOf.some((part) => validateAgainst(value, part, at).length === 0)) {
    errors.push(`${at}: matches none of anyOf`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if ('const' in schema && schema.const !== value) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.format === 'date' && !DATE.test(value)) errors.push(`${at}: '${value}' is not a plain date`);
    if (schema.format === 'date-time' && !DATE_TIME.test(value)) errors.push(`${at}: '${value}' is not an offset timestamp`);
    if (schema.format === 'email' && !EMAIL.test(value)) errors.push(`${at}: '${value}' is not an email`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push(`${at}: not above ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainst(item, schema.items, `${at}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing required '${key}'`);
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) errors.push(...validateAgainst(child, properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property '${key}'`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainst(child, schema.additionalProperties, `${at}.${key}`));
      }
    }
  }
  return errors;
};

// The response schema the contract declares for (path template, method, status).
export const responseSchemaFor = (pathTemplate, method, status) => {
  const operation = MOBILE_CONTRACT.paths?.[pathTemplate]?.[method.toLowerCase()];
  if (!operation) throw new Error(`No contract operation ${method} ${pathTemplate}`);
  let response = operation.responses?.[String(status)];
  if (!response) return null;
  if (response.$ref) response = resolveRef(response.$ref);
  return response.content?.['application/json']?.schema || null;
};

export const componentSchema = (name) => MOBILE_CONTRACT.components.schemas[name];

export const contractOperations = () => Object.entries(MOBILE_CONTRACT.paths)
  .flatMap(([pathTemplate, item]) => Object.keys(item)
    .filter((method) => ['get', 'post', 'put', 'delete', 'patch'].includes(method))
    .map((method) => ({ pathTemplate, method: method.toUpperCase(), operationId: item[method].operationId })));
