import { expect, test } from 'vitest';
import { compareGuideTranslationStates, compareTakeoverGuide } from '../scripts/guide-takeover-validation.mjs';

const states = () => ['zhHant', 'zhHans'].map(locale => ({ field: 'title', locale, sourceHash: null,
  origin: 'protected_legacy', glossaryVersion: 'ihear-2026-08-v1', updatedAt: '2026-09-05T17:58:48.306Z', updatedBy: 'migration-017' }));
const guide = () => ({ id: 'guide-communication', title: { en: 'Guide', zhHant: '指南', zhHans: '指南' },
  sortOrder: 10, status: 'published', type: 'email_request', states: states() });

test('same records in different order pass without mutating either input', () => {
  const expected = states(), actual = states().reverse(), before = structuredClone({ expected, actual });
  expect(compareGuideTranslationStates(expected, actual).pass).toBe(true);
  expect({ expected, actual }).toEqual(before);
  const a = guide(), b = guide(); b.states.reverse();
  expect(compareTakeoverGuide(a, b).pass).toBe(true);
});
test('missing language fails with identity and count evidence', () => {
  const result = compareGuideTranslationStates(states(), states().slice(0, 1));
  expect(result.pass).toBe(false);
  expect(result.missing).toEqual([['title', 'zhHans']]);
  expect(result.expectedCount).toBe(2); expect(result.actualCount).toBe(1);
});
test('duplicate language fails even when the total count matches', () => {
  const result = compareGuideTranslationStates(states(), [states()[0], states()[0]]);
  expect(result.pass).toBe(false); expect(result.duplicateActual).toEqual([['title', 'zhHant']]);
  expect(result.missing).toEqual([['title', 'zhHans']]);
});
test.each(['sourceHash', 'origin', 'glossaryVersion', 'updatedAt', 'updatedBy'])('changed %s fails despite reordered records', field => {
  const actual = states().reverse(); actual[0][field] = 'CHANGED';
  const result = compareGuideTranslationStates(states(), actual);
  expect(result.pass).toBe(false); expect(result.valueChanges).toHaveLength(1);
});
test('unexpected extra record fails', () => {
  const result = compareGuideTranslationStates(states(), [...states(), { ...states()[0], locale: 'en' }]);
  expect(result.pass).toBe(false); expect(result.unexpected).toEqual([['title', 'en']]);
});
test('different language with the same count fails', () => {
  const actual = states(); actual[0].locale = 'en';
  const result = compareGuideTranslationStates(states(), actual);
  expect(result.pass).toBe(false); expect(result.missing).toEqual([['title', 'zhHant']]);
  expect(result.unexpected).toEqual([['title', 'en']]);
});
test('duplicate identities in expected data also fail', () => {
  expect(compareGuideTranslationStates([states()[0], states()[0]], [states()[0], states()[0]]).pass).toBe(false);
});
test('field is part of the identity; same locale in distinct fields is valid', () => {
  const expected = [...states(), ...states().map(s => ({ ...s, field: 'description' }))];
  expect(compareGuideTranslationStates(expected, [...expected].reverse()).pass).toBe(true);
  const actual = states(); actual[0].field = 'description';
  expect(compareGuideTranslationStates(states(), actual).pass).toBe(false);
});
test('unexpected extra fields fail, including undefined-valued fields', () => {
  for (const extra of ['unexpected', undefined]) {
    const actual = states(); actual[0].extra = extra;
    expect(compareGuideTranslationStates(states(), actual).pass).toBe(false);
  }
});
test('missing field, null, empty string and changed runtime type remain distinct', () => {
  for (const value of [undefined, '', 0]) {
    const actual = states(); actual[0].sourceHash = value;
    expect(compareGuideTranslationStates(states(), actual).pass).toBe(false);
  }
  const actual = states(); delete actual[0].sourceHash;
  expect(compareGuideTranslationStates(states(), actual).pass).toBe(false);
});
test('only top-level state ordering is ignored, not nested arrays', () => {
  const expected = states(); expected[0].history = ['a', 'b'];
  const actual = structuredClone(expected); actual[0].history.reverse();
  expect(compareGuideTranslationStates(expected, actual).pass).toBe(false);
});
test('Guide content, item order and unrelated arrays are still checked', () => {
  for (const change of [g => { g.sortOrder = 20; }, g => { g.title.zhHant = '變更'; },
    g => { g.extra = true; }, g => { g.id = 'other-guide'; }]) {
    const actual = guide(); actual.states.reverse(); change(actual);
    expect(compareTakeoverGuide(guide(), actual).pass).toBe(false);
  }
  const expected = guide(), actual = guide(); expected.items = ['a', 'b']; actual.items = ['b', 'a'];
  expect(compareTakeoverGuide(expected, actual).pass).toBe(false);
});
test('malformed or absent states fail closed', () => {
  for (const actual of [null, undefined, {}, [null], [{ field: 'title' }], [{ field: '', locale: 'zhHant' }]]) {
    expect(compareGuideTranslationStates(states(), actual).pass).toBe(false);
  }
  expect(compareTakeoverGuide(guide(), undefined).pass).toBe(false);
  const actual = guide(); delete actual.states;
  expect(compareTakeoverGuide(guide(), actual).pass).toBe(false);
});
