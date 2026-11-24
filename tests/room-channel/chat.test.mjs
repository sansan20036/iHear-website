// The room's public chat, server logic (lib/room-channel/chat.mjs): local tests only, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_LIMITS, end, expired, invalidMessage, newChat, post, since } from '../../lib/room-channel/chat.mjs';

const T0 = 1_800_000_000_000;
const fresh = () => newChat({ roomId: 'FR-1', lessonId: 'L-1', now: T0 });
let counter = 0;
const say = (text, more = {}) => ({ op: `m${(counter += 1)}`, text, ...more });
const send = (state, by, input, now, name = `Name ${by}`) => post(state, { by, name, member: true, input, now });

test('RC-1: a message has no receiver: a request that names one is refused, whatever it is called', () => {
  for (const field of ['to', 'recipient', 'receiver', 'userId', 'user', 'private', 'dm', 'target']) {
    assert.equal(invalidMessage({ ...say('hello'), [field]: 'P-2' }), 'PRIVATE_NOT_OFFERED', field);
    const out = send(fresh(), 'P-1', { ...say('hello'), [field]: 'P-2' }, T0 + 10);
    assert.equal(out.answer.error, 'PRIVATE_NOT_OFFERED');
    assert.equal(out.state.messages.length, 0);
  }
  // Any other extra field is refused too: the request is the text and its name, nothing else.
  assert.equal(invalidMessage({ ...say('hello'), name: 'Someone Else' }), 'FIELDS');
  assert.equal(invalidMessage({ ...say('hello'), by: 'P-9' }), 'FIELDS');
  assert.equal(invalidMessage({ text: 'hello' }), 'FIELDS');
});

test('RC-2: what was sent reaches everyone in the room alike, in the server\'s order, under the name the server gives', () => {
  let state = fresh();
  state = send(state, 'P-1', say('first'), T0 + 100, 'Kyle').state;
  state = send(state, 'P-2', say('  second  '), T0 + 200, 'Tutor').state;
  state = send(state, 'P-1', say('third\nline two'), T0 + 300, 'Kyle').state;
  const seenBy = by => since(state, { by, member: true, cursor: 0 });
  const expected = [
    { seq: 1, at: T0 + 100, by: 'P-1', name: 'Kyle', text: 'first' },
    { seq: 2, at: T0 + 200, by: 'P-2', name: 'Tutor', text: 'second' },
    { seq: 3, at: T0 + 300, by: 'P-1', name: 'Kyle', text: 'third\nline two' },
  ];
  for (const by of ['P-1', 'P-2', 'P-3']) assert.deepEqual(seenBy(by).messages, expected, by);     // P-3 wrote nothing and reads the same
  assert.equal(since(state, { by: 'P-9', member: false, cursor: 0 }).error, 'NOT_IN_ROOM');
  assert.deepEqual(since(state, { by: 'P-3', member: true, cursor: 2 }).messages.map(message => message.seq), [3]);
  assert.equal(since(state, { by: 'P-3', member: true, cursor: -1 }).error, 'CURSOR');
});

test('RC-3: only a person in the room, and only while the lesson runs', () => {
  assert.equal(post(fresh(), { by: 'P-1', name: 'K', member: false, input: say('x'), now: T0 }).answer.error, 'NOT_IN_ROOM');
  assert.equal(post(fresh(), { by: '', name: 'K', member: true, input: say('x'), now: T0 }).answer.error, 'NOT_IN_ROOM');
  const ended = end(send(fresh(), 'P-1', say('before the end'), T0 + 10).state, T0 + 1000);
  assert.equal(send(ended, 'P-1', say('after'), T0 + 2000).answer.error, 'LESSON_ENDED');
});

test('RC-4: the text is checked', () => {
  assert.equal(invalidMessage(say('ok')), null);
  assert.equal(invalidMessage(say('   ')), 'TEXT');
  assert.equal(invalidMessage(say('')), 'TEXT');
  assert.equal(invalidMessage(say(42)), 'TEXT');
  assert.equal(invalidMessage(say('a'.repeat(CHAT_LIMITS.textLength))), null);
  assert.equal(invalidMessage(say('a'.repeat(CHAT_LIMITS.textLength + 1))), 'TEXT');
  assert.equal(invalidMessage(say('中'.repeat(CHAT_LIMITS.textLength))), null);              // counted in characters, not bytes
  assert.equal(invalidMessage(say('bell\u0007')), 'TEXT');
  assert.equal(invalidMessage({ op: 'bad name!', text: 'x' }), 'OP_NAME');
  assert.equal(invalidMessage('hello'), 'NOT_AN_OBJECT');
});

test('RC-5: the same request twice counts once; one person cannot flood the room', () => {
  const input = say('once');
  const one = send(fresh(), 'P-1', input, T0 + 10);
  const again = send(one.state, 'P-1', input, T0 + 20);
  assert.deepEqual(again.answer, { ok: true, seq: 1, duplicate: true });
  assert.equal(again.state.messages.length, 1);
  let state = fresh(), refusedAt = null;
  for (let n = 0; n < CHAT_LIMITS.perSender + 3 && refusedAt === null; n += 1) {
    const out = send(state, 'P-1', say(`burst ${n}`), T0 + n);
    if (!out.answer.ok) { refusedAt = n; assert.equal(out.answer.error, 'TOO_FAST'); }
    state = out.state;
  }
  assert.equal(refusedAt, CHAT_LIMITS.perSender);
  assert.equal(send(state, 'P-2', say('someone else'), T0 + 50).answer.ok, true);
  assert.equal(send(state, 'P-1', say('later'), T0 + CHAT_LIMITS.rateWindowMs + 50).answer.ok, true);
});

test('RC-6: only the latest messages are kept; someone who was away longer is told some were missed', () => {
  let state = fresh();
  for (let n = 0; n < CHAT_LIMITS.kept + 40; n += 1) state = send(state, `P-${n % 20}`, say(`message ${n}`), T0 + n * 2000).state;
  assert.equal(state.messages.length, CHAT_LIMITS.kept);
  assert.equal(state.base, 40);
  const far = since(state, { by: 'P-1', member: true, cursor: 5 });
  assert.equal(far.missed, true);
  assert.equal(far.messages.length, CHAT_LIMITS.page);
  assert.equal(far.more, true);
  assert.equal(far.messages[0].seq, 41);
  const near = since(state, { by: 'P-1', member: true, cursor: CHAT_LIMITS.kept + 30 });
  assert.equal(near.missed, false);
  assert.equal(near.messages.length, 10);
  assert.equal(near.more, false);
});

test('RC-7: when the lesson ends every message is deleted at once', () => {
  let state = fresh();
  state = send(state, 'P-1', say('a private thought said in public'), T0 + 10).state;
  state = send(state, 'P-2', say('an answer'), T0 + 20).state;
  const ended = end(state, T0 + 5000);
  assert.equal(JSON.stringify(ended).includes('private thought'), false);
  assert.equal(JSON.stringify(ended).includes('an answer'), false);
  assert.deepEqual(ended.messages, []);
  assert.deepEqual(ended.names, {});
  const after = since(ended, { by: 'P-1', member: true, cursor: 0 });
  assert.deepEqual(after.messages, []);
  assert.equal(after.ended, true);
  assert.equal(expired(ended, T0 + 5001), true);
  // A chat nobody ended is deleted after it has been idle long enough.
  assert.equal(expired(state, T0 + 20 + CHAT_LIMITS.idleMs - 1), false);
  assert.equal(expired(state, T0 + 20 + CHAT_LIMITS.idleMs), true);
  assert.equal(end(ended, T0 + 9000), ended);
});
