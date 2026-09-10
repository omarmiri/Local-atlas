/* Nothing becomes a fact on a page headed "Confirmed by phone" unless it binds
   on every axis. These are the refusals — the part of calle.js least reachable
   through a real call and most load-bearing if it is wrong. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calle, boundPair } = require('./helpers');
const { bindResult, evidenceCheck, completionCheck } = calle;

/* ---- completionCheck: terminal is not the same as successful ---- */

test('a completed call with an affirmative task verdict passes', () => {
  assert.equal(completionCheck('completed', true).ok, true);
});

test('a call that did not complete cannot become a fact', () => {
  for(const st of ['failed', 'canceled', 'in_progress', '', null]){
    const r = completionCheck(st, true);
    assert.equal(r.ok, false, `status ${st}`);
    assert.match(r.reason, /not completed|no status/);
  }
});

test('no verdict is not the same as a verdict for', () => {
  assert.equal(completionCheck('completed', false).ok, false);
  assert.equal(completionCheck('completed', null).ok, false);
  assert.equal(completionCheck('completed', undefined).ok, false);
  assert.match(completionCheck('completed', undefined).reason, /no task-completion verdict/);
});

/* ---- evidenceCheck: an answer has to be traceable to something said ---- */

const staff = text => [{ speaker: 'agent', text: 'Do you have high chairs?' },
                       { speaker: 'user',  text }];
const answered = quote => ({ answer_status: 'answered', answer: 'Yes', evidence_quote: quote });

test('a quote lifted from what a staff member said binds', () => {
  const r = evidenceCheck(answered('we have three high chairs'),
                          staff('Yes, we have three high chairs by the window.'));
  assert.equal(r.ok, true);
  assert.equal(r.result.answer_status, 'answered');
});

test('punctuation and casing do not break the binding', () => {
  const r = evidenceCheck(answered('We open at nine.'),
                          staff('we open at nine on weekdays'));
  assert.equal(r.ok, true);
});

test('a short quote binds when it is exactly one whole turn', () => {
  const r = evidenceCheck(answered('Yes, we do.'), staff('Yes we do'));
  assert.equal(r.ok, true, 'a whole turn is unambiguous however short');
});

test('an ungrounded answer is downgraded to unclear, not published', () => {
  const r = evidenceCheck(answered('we have a rooftop terrace'),
                          staff('Yes, we have three high chairs.'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not grounded/);
  assert.equal(r.result.answer_status, 'unclear');
  assert.equal(r.result.answer, '');
  assert.equal(r.result.evidence_quote, '');
});

test('an answer with nobody answering is not a fact about the place at all', () => {
  const r = evidenceCheck(answered('we have high chairs'),
                          [{ speaker: 'agent', text: 'Hello?' }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no staff turn/);
  assert.equal(r.result.answer_status, 'unknown');
});

test('a result that never claimed to be answered passes through untouched', () => {
  for(const st of ['unclear', 'refused', 'unreachable', 'unknown']){
    const r = evidenceCheck({ answer_status: st, answer: '', evidence_quote: '' }, []);
    assert.equal(r.ok, true, st);
    assert.equal(r.result.answer_status, st);
  }
});

/* ---- bindResult: the seven axes ---- */

test('a matching request and call bind, and the right attempt comes back', () => {
  const { pending, call, phone } = boundPair();
  const r = bindResult(pending, call);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.attempt.phone, phone,
    'the attempt must be the one on the line we asked for, not recipients[0]');
});

test('no stored request means nothing to publish against', () => {
  const { call } = boundPair();
  assert.match(bindResult(null, call).reason, /no stored request/);
  assert.match(bindResult({}, call).reason, /no stored request/);
});

test('a call id that is not the one we stored is refused', () => {
  const { pending, call } = boundPair();
  assert.match(bindResult(pending, { ...call, id: 'call_other' }).reason, /does not match/);
});

test('a call that is not terminal is refused', () => {
  const { pending, call } = boundPair();
  for(const st of ['in_progress', 'queued', 'ringing']){
    assert.match(bindResult(pending, { ...call, status: st }).reason, /not terminal/);
  }
});

test('a transcript from some other script is refused', () => {
  const { pending, call } = boundPair();
  const r = bindResult(pending, { ...call, task: 'Call them and book a table for four.' });
  assert.match(r.reason, /task does not match the script we sent/);
});

test('a record that is not this app is refused', () => {
  const { pending, call } = boundPair();
  const r = bindResult(pending, { ...call, metadata: { ...call.metadata, app: 'other-app' } });
  assert.match(r.reason, /not this app/);
});

test('metadata that disagrees with the stored request is refused on each axis', () => {
  const { pending, call } = boundPair();
  const cases = [
    ['place_key', 'g:somewhere-else',  /place_key mismatch/],
    ['q_hash',    'differenthash',     /q_hash mismatch/],
    ['question',  'Do you take dogs?', /question mismatch/]
  ];
  for(const [field, value, expected] of cases){
    const r = bindResult(pending, { ...call, metadata: { ...call.metadata, [field]: value } });
    assert.equal(r.ok, false, field);
    assert.match(r.reason, expected);
  }
});

test('a private result cannot arrive claiming to be public', () => {
  const { pending, call } = boundPair({ private: true });
  const r = bindResult(pending, { ...call, metadata: { ...call.metadata, visibility: 'public' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /visibility mismatch/);
});

test('a public result cannot arrive claiming to be private', () => {
  const { pending, call } = boundPair();
  const r = bindResult(pending, { ...call, metadata: { ...call.metadata, visibility: 'private' } });
  assert.match(r.reason, /visibility mismatch/);
});

test('a private record with no owner is refused as its own rule', () => {
  const { pending, call } = boundPair({ private: true, pending: { uid: null } });
  const r = bindResult(pending, call);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing its owner/);
});

test('a call that never rang the number we asked for is refused', () => {
  const { pending, call } = boundPair();
  const r = bindResult(pending, { ...call, recipients: [
    { phones: ['+12125559999'], attempts: [{ phone: '+12125559999' }] }
  ]});
  assert.match(r.reason, /no recipient matches the number we dialled/);
});

test('the number is matched however the provider formatted it', () => {
  const { pending, call } = boundPair();
  const r = bindResult(pending, { ...call, recipients: [
    { phones: ['(212) 555-0134'], attempts: [{ phone: '212-555-0134', status: 'completed' }] }
  ]});
  assert.equal(r.ok, true, r.reason);
});

test('a stored request with no fingerprint or number binds nothing', () => {
  const { pending, call } = boundPair();
  assert.match(bindResult({ ...pending, taskHash: '' }, call).reason, /no task fingerprint/);
  assert.match(bindResult({ ...pending, phone: '' }, call).reason, /no dialled number/);
});
