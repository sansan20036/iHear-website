// Offline validation only. No database, environment loading or migration writes.
import { isDeepStrictEqual } from 'node:util';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

// The enclosing Guide identifies the resource. Within it, (field, locale) is
// the translation-state identity. Never sort other arrays or project fields
// away: extra fields, types, null/undefined and nested array order remain data.
export function compareGuideTranslationStates(expected, actual) {
  const result = { pass: false, expectedCount: Array.isArray(expected) ? expected.length : null,
    actualCount: Array.isArray(actual) ? actual.length : null, invalid: [],
    duplicateExpected: [], duplicateActual: [], missing: [], unexpected: [], valueChanges: [] };
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    result.invalid.push('Translation states must be arrays');
    return result;
  }
  function index(rows, side) {
    const map = new Map();
    rows.forEach((row, position) => {
      if (!record(row) || typeof row.field !== 'string' || !row.field.trim()
        || typeof row.locale !== 'string' || !row.locale.trim()) {
        result.invalid.push({ side, position });
        return;
      }
      const key = JSON.stringify([row.field, row.locale]);
      if (map.has(key)) result[side === 'expected' ? 'duplicateExpected' : 'duplicateActual'].push([row.field, row.locale]);
      else map.set(key, row);
    });
    return map;
  }
  const before = index(expected, 'expected'), after = index(actual, 'actual');
  for (const [key, row] of before) {
    if (!after.has(key)) result.missing.push(JSON.parse(key));
    else if (!isDeepStrictEqual(row, after.get(key))) result.valueChanges.push({ identity: JSON.parse(key), expected: row, actual: after.get(key) });
  }
  for (const key of after.keys()) if (!before.has(key)) result.unexpected.push(JSON.parse(key));
  result.pass = expected.length === actual.length && ['invalid', 'duplicateExpected', 'duplicateActual', 'missing', 'unexpected', 'valueChanges'].every(key => result[key].length === 0);
  return result;
}

export function compareTakeoverGuide(expected, actual) {
  if (!record(expected) || !record(actual)) return { pass: false, nonStateFieldsEqual: false, states: null };
  const { states: expectedStates, ...expectedFields } = expected;
  const { states: actualStates, ...actualFields } = actual;
  const states = compareGuideTranslationStates(expectedStates, actualStates);
  const nonStateFieldsEqual = isDeepStrictEqual(expectedFields, actualFields);
  return { pass: nonStateFieldsEqual && states.pass, nonStateFieldsEqual, states };
}
