// Schema-aware transport normalization. Never coerce arbitrary strings or reorder
// nested JSON arrays. Reject unsafe numeric transport rather than round bigint.
export function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stableJson(item))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stableJson(value[key]))])));
  if (value === undefined) throw new Error('Undefined is not a JSON value');
  return JSON.stringify(value);
}
export function exactInteger(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe integer transport');
  if (!['number', 'string', 'bigint'].includes(typeof value) || !/^-?\d+$/.test(String(value))) throw new Error('Invalid integer transport');
  return BigInt(value).toString();
}
export function timestampMicroseconds(value) {
  if (typeof value !== 'string') throw new Error('Invalid timestamp transport');
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!m) throw new Error('Unsupported timestamp precision/zone');
  const secondsMs = Date.parse(`${m[1]}T${m[2]}Z`);
  if (!Number.isSafeInteger(secondsMs)) throw new Error('Invalid timestamp');
  const zone = m[4]; const offset = zone === 'Z' ? 0 : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) * (zone[0] === '+' ? 1 : -1);
  return (BigInt(secondsMs) * 1000n - BigInt(offset) * 60000000n + BigInt((m[3] || '').padEnd(6, '0'))).toString();
}
function normalized(value, column) {
  if (value === null) return null;
  if (column?.udt_name === 'int8') return exactInteger(value);
  if (column?.udt_name === 'timestamptz') return timestampMicroseconds(value);
  return value;
}
const describe = (row, field) => ({ present: Object.hasOwn(row, field), type: row[field] === null ? 'null' : typeof row[field], value: row[field] === undefined ? '<undefined>' : row[field], serialized: JSON.stringify(row[field]) ?? '<undefined>' });
export function compareRestoredTable(name, before, after, schema) {
  const columns = schema.columns.filter(column => column.table_name === name);
  const constraint = schema.constraints.find(row => row.table_name === name && row.definition.startsWith('PRIMARY KEY ('));
  if (!constraint) throw new Error('Missing primary key metadata: ' + name);
  const keys = constraint.definition.slice('PRIMARY KEY ('.length).split(')')[0].split(',').map(key => key.trim().replaceAll('"', ''));
  const identity = row => stableJson(keys.map(key => normalized(row[key], columns.find(column => column.column_name === key))));
  const index = rows => { const map = new Map(), duplicates = []; for (const row of rows) { const id = identity(row); if (map.has(id)) duplicates.push(id); map.set(id, row); } return { map, duplicates }; };
  const old = index(before), next = index(after);
  const result = { table: name, primaryKey: keys, beforeCount: before.length, afterCount: after.length,
    missing: [...old.map.keys()].filter(key => !next.map.has(key)), added: [...next.map.keys()].filter(key => !old.map.has(key)),
    duplicateBefore: old.duplicates, duplicateAfter: next.duplicates, representationChanges: [], valueChanges: [] };
  for (const [key, row] of old.map) {
    const actual = next.map.get(key); if (!actual) continue;
    for (const field of new Set([...Object.keys(row), ...Object.keys(actual)])) {
      const a = describe(row, field), b = describe(actual, field), column = columns.find(column => column.column_name === field);
      if (a.present === b.present && a.serialized === b.serialized) continue;
      const same = a.present && b.present && stableJson(normalized(row[field], column)) === stableJson(normalized(actual[field], column));
      const difference = { key: JSON.parse(key), field, databaseType: column?.data_type, before: a, after: b };
      (same ? result.representationChanges : result.valueChanges).push(difference);
    }
  }
  result.pass = before.length === after.length && !result.missing.length && !result.added.length && !result.duplicateBefore.length && !result.duplicateAfter.length && !result.valueChanges.length;
  return result;
}
