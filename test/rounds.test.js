/* A comparison round dials several businesses with one script. Two things are
   different from a single call and both are tested here: each place's answer is
   a fact about that place, and the comparison is not a fact anybody said. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calle, sha256, qh } = require('./helpers');
const { bindRound, bindVerdict, recipientCheck, buildRoundTask, ROUND_MIN, ROUND_MAX } = calle;

const QUESTION = 'How long is the wait for a table for four right now?';
const PLACES = [
  { phone: '+12125550134', name: "Rosa's Pizzeria" },
  { phone: '+12125550178', name: 'The Corner Diner' },
  { phone: '+12125550199', name: 'Bistro Nine' }
];

function roundPair(over = {}){
  const question = over.question || QUESTION;
  const places = over.places || PLACES;
  const task = buildRoundTask({ noun: 'restaurant', question, country: 'US' });
  const pending = {
    round: true, callId: 'call_round_1', roundId: 'round_abc', qHash: qh(question),
    taskHash: sha256(task), question, uid: 'user_1', places, ...(over.pending || {})
  };
  const call = {
    id: 'call_round_1', status: 'completed', task,
    metadata: { app: 'local-atlas', kind: 'round', round_id: 'round_abc', q_hash: qh(question),
                question, visibility: 'private',
                recipients: places.map(p => ({ phone: p.phone, name: p.name })),
                ...(over.metadata || {}) },
    ...(over.call || {})
  };
  return { pending, call, task, places, question };
}

/* ---- the script read to several strangers ---- */

test('the round script names no business, because all of them hear it', () => {
  const task = buildRoundTask({ noun: 'restaurant', question: QUESTION, country: 'US' });
  for(const p of PLACES){
    assert.ok(!task.includes(p.name), `${p.name} must not appear in the script`);
    assert.ok(!task.includes(p.phone), `${p.phone} must not appear in the script`);
  }
  assert.match(task, /Call the business on the number given for this recipient/);
});

test('rule 16 forbids hinting that anyone else is being called', () => {
  const task = buildRoundTask({ noun: 'restaurant', question: QUESTION, country: 'US' });
  assert.match(task, /Never say so, never mention, compare, name, or hint at any other business/);
  assert.match(task, /not able to discuss other calls/);
});

test('the round script still carries the unconditional disclosure', () => {
  const task = buildRoundTask({ noun: 'restaurant', question: QUESTION, country: 'US' });
  assert.ok(task.includes(calle.DISCLOSURE), 'the AI disclosure is in the script');
  assert.match(task, /Never deny it, never deflect/);
  assert.match(task, new RegExp(QUESTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a Canadian round is not told it is American', () => {
  const ca = buildRoundTask({ noun: 'restaurant', question: QUESTION, country: 'CA' });
  const us = buildRoundTask({ noun: 'restaurant', question: QUESTION, country: 'US' });
  assert.match(ca, /Canadian business/);
  assert.ok(!ca.includes('local US business'));
  assert.match(us, /US business/);
});

test('a round that straddles the border claims neither country', () => {
  const mixed = buildRoundTask({ noun: 'restaurant', question: QUESTION, country: '' });
  assert.ok(!/Canadian business/.test(mixed) || !/local US business/.test(mixed),
    'a mixed round must not assert both');
});

test('a round is two or three places, never one and never a campaign', () => {
  assert.equal(ROUND_MIN, 2);
  assert.equal(ROUND_MAX, 3);
});

/* ---- each place answers for itself ---- */

test('a recipient that did not complete its own dial is refused', () => {
  assert.equal(recipientCheck({ status: 'completed' }).ok, true);
  for(const st of ['pending', 'in_progress', 'failed', 'skipped', '', null, undefined]){
    const r = recipientCheck({ status: st });
    assert.equal(r.ok, false, `status ${st}`);
    assert.match(r.reason, /not completed|no status/);
  }
});

/* ---- bindRound ---- */

test('a matching round binds', () => {
  const { pending, call } = roundPair();
  assert.equal(bindRound(pending, call).ok, true, bindRound(pending, call).reason);
});

test('a round is private by construction, and a record saying otherwise is not ours', () => {
  const { pending, call } = roundPair();
  const r = bindRound(pending, { ...call, metadata: { ...call.metadata, visibility: 'public' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /private by construction/);
});

test('a round record with no owner is refused', () => {
  const { pending, call } = roundPair({ pending: { uid: null } });
  assert.match(bindRound(pending, call).reason, /missing its owner/);
});

test('a single call cannot be read back as a round', () => {
  const { pending, call } = roundPair();
  assert.match(bindRound({ ...pending, round: false }, call).reason, /no stored round/);
  assert.match(bindRound(pending, { ...call, metadata: { ...call.metadata, kind: 'single' } }).reason,
               /kind is not a round/);
});

test('a round id that is not the one we stored is refused', () => {
  const { pending, call } = roundPair();
  assert.match(bindRound(pending, { ...call, metadata: { ...call.metadata, round_id: 'round_xyz' } }).reason,
               /round_id mismatch/);
});

test('the recipient mapping has to be the list we actually sent', () => {
  const { pending, call } = roundPair();
  const swapped = [...PLACES.slice(0, 2), { phone: '+12125550000', name: 'Somebody Else' }];
  const r = bindRound(pending, { ...call,
    metadata: { ...call.metadata, recipients: swapped.map(p => ({ phone: p.phone, name: p.name })) } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /recipient mapping does not match/);
});

test('but the order the API returns them in is its business, not ours', () => {
  const { pending, call } = roundPair();
  const reversed = [...call.metadata.recipients].reverse();
  assert.equal(bindRound(pending, { ...call, metadata: { ...call.metadata, recipients: reversed } }).ok,
               true);
});

test('a round placed before the mapping shipped binds on everything else', () => {
  const { pending, call } = roundPair();
  const md = { ...call.metadata };
  delete md.recipients;
  assert.equal(bindRound(pending, { ...call, metadata: md }).ok, true);
});

test('a round transcript from some other script is refused', () => {
  const { pending, call } = roundPair();
  assert.match(bindRound(pending, { ...call, task: 'Call three restaurants and book the fastest.' }).reason,
               /task does not match/);
});

/* ---- the verdict nobody said out loud ---- */

const results = [
  { phone: '+12125550134', name: "Rosa's Pizzeria",  answerStatus: 'answered' },
  { phone: '+12125550178', name: 'The Corner Diner', answerStatus: 'answered' },
  { phone: '+12125550199', name: 'Bistro Nine',      answerStatus: 'unreachable' }
];

test('a winner identified by number is bound to a place we actually dialled', () => {
  const v = bindVerdict({ comparable: 'yes', best_recipient_phone: '+12125550178',
                          reason: 'shortest wait' }, results);
  assert.equal(v.bestPlace, 'The Corner Diner');
  assert.equal(v.comparable, 'yes');
});

test('a name is accepted as a second channel when the provider surfaces one', () => {
  const v = bindVerdict({ comparable: 'yes', best_place: "rosa's pizzeria" }, results);
  assert.equal(v.bestPlace, "Rosa's Pizzeria");
});

test('a winner this round never called is dropped, not shown', () => {
  const v = bindVerdict({ comparable: 'yes', best_place: 'Some Other Cafe' }, results);
  assert.equal(v.bestPlace, '');
  assert.match(v.note, /a business this round did not call/);
});

test('a winner that never answered is dropped', () => {
  const v = bindVerdict({ comparable: 'yes', best_recipient_phone: '+12125550199' }, results);
  assert.equal(v.bestPlace, '');
  assert.match(v.note, /did not answer/);
});

test('an unrecognised comparable verdict falls closed to no', () => {
  assert.equal(bindVerdict({ comparable: 'maybe' }, results).comparable, 'no');
  assert.equal(bindVerdict({}, results).comparable, 'no');
});

test('a phone number in the reason is read back as the business it belongs to', () => {
  const v = bindVerdict({ comparable: 'yes', best_recipient_phone: '+12125550134',
    reason: '+12125550134 quoted ten minutes, +12125550178 quoted forty.' }, results);
  assert.ok(v.reason.includes("Rosa's Pizzeria"));
  assert.ok(v.reason.includes('The Corner Diner'));
  assert.ok(!/\d{10}/.test(v.reason), 'no raw number survives into the reason');
});

test('a number belonging to nobody in this round is not left on screen', () => {
  const v = bindVerdict({ comparable: 'yes', reason: 'We also heard +13105550188 was quicker.' },
                        results);
  assert.match(v.reason, /another of them/);
  assert.ok(!v.reason.includes('3105550188'));
});
