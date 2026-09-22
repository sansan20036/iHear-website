import { expect, test } from 'vitest';
import { compareRestoredTable, exactInteger, timestampMicroseconds } from '../scripts/restore-comparison.mjs';
const schema = { columns: [{ table_name: 't', column_name: 'id', udt_name: 'text' }, { table_name: 't', column_name: 'revision', udt_name: 'int8' }, { table_name: 't', column_name: 'updated_at', udt_name: 'timestamptz' }], constraints: [{ table_name: 't', definition: 'PRIMARY KEY (id)' }] };
const compare = (a, b) => compareRestoredTable('t', a, b, schema);
test('Bigint normalization is exact past the safe integer limit', () => {
  expect(exactInteger('9223372036854775807')).toBe('9223372036854775807');
  expect(compare([{ id: 'a', revision: '2386' }], [{ id: 'a', revision: 2386 }]).pass).toBe(true);
  expect(compare([{ id: 'a', revision: '9007199254740992' }], [{ id: 'a', revision: '9007199254740993' }]).pass).toBe(false);
  expect(() => exactInteger(9007199254740992)).toThrow('Unsafe');
});
test('Timestamp offsets and trailing zeroes preserve exact microseconds', () => {
  expect(timestampMicroseconds('2026-09-21T17:02:49.510Z')).toBe(timestampMicroseconds('2026-09-22T01:02:49.51+08:00'));
  expect(timestampMicroseconds('2026-09-21T17:02:49.510001Z')).not.toBe(timestampMicroseconds('2026-09-21T17:02:49.510Z'));
  expect(compare([{ id: 'a', updated_at: '2026-09-21T17:02:49.510Z' }], [{ id: 'a', updated_at: '2026-09-21T17:02:49.510001Z' }]).pass).toBe(false);
});
test('Null, missing and empty string are distinct', () => {
  for (const [a, b] of [[{ x: null }, {}], [{ x: '' }, { x: null }], [{ x: '' }, {}]]) expect(compare([{ id: 'a', ...a }], [{ id: 'a', ...b }]).pass).toBe(false);
});
test('Object keys and table row order are incidental; nested array order is data', () => {
  expect(compare([{ id: 'a', x: { a: 1, b: 2 } }, { id: 'b' }], [{ id: 'b' }, { x: { b: 2, a: 1 }, id: 'a' }]).pass).toBe(true);
  expect(compare([{ id: 'a', x: [1, 2] }], [{ id: 'a', x: [2, 1] }]).pass).toBe(false);
});
test('Missing and duplicated keys are not normalized away', () => {
  expect(compare([{ id: 'a' }], []).missing).toEqual(['["a"]']);
  expect(compare([{ id: 'a' }], [{ id: 'a' }, { id: 'a' }]).pass).toBe(false);
});
test('Only schema-declared fields receive type normalization', () => {
  expect(compare([{ id: 'a', text: '123' }], [{ id: 'a', text: 123 }]).pass).toBe(false);
  expect(compare([{ id: 'a', x: { revision: '123' } }], [{ id: 'a', x: { revision: 123 } }]).pass).toBe(false);
});
