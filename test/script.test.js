/* The call script and the shape of the answer. Every guardrail the README
   claims is in the task string is asserted to be in the task string. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calle, PLACE, QUESTION, PHONE } = require('./helpers');
const { buildTask, placeNoun, openerFor, templatesFor, TEMPLATES,
        RESULT_SCHEMA, DISCLOSURE, realCallOk } = calle;

const task = (over = {}) =>
  buildTask({ place: { ...PLACE, ...(over.place || {}) },
              question: over.question || QUESTION,
              phone: over.phone || PHONE });

test('the agent discloses that it is AI, unconditionally and before the question', () => {
  const t = task();
  assert.ok(t.includes(DISCLOSURE));
  assert.match(DISCLOSURE, /I'm an AI assistant/);
  assert.match(t, /Say it even if they did not ask who you are/);
  assert.match(t, /Never ask your question before you have said it/);
  assert.ok(t.indexOf(DISCLOSURE) < t.indexOf(QUESTION),
    'the disclosure comes before the question in the script');
});

test('the agent may never deny being an AI', () => {
  assert.match(task(), /Never deny it, never deflect the question, and never claim or imply that you are a person/);
});

test('it asks for a good moment before saying anything else', () => {
  const t = task();
  assert.match(t, /Let them finish that greeting before you say a single word/);
  assert.ok(t.includes(openerFor(PLACE)));
  assert.ok(t.indexOf(openerFor(PLACE)) < t.indexOf(DISCLOSURE));
});

test('it backs off rather than pushing when it is a bad moment', () => {
  assert.match(task(), /if they say it is a bad moment or ask you to call back.*Do not push/s);
});

test('exactly one question, and at most one clarifying follow-up', () => {
  const t = task();
  assert.match(t, /ask exactly this one question and nothing else/);
  assert.match(t, /at most one short clarifying follow-up/);
});

test('it never guesses — not knowing is a valid recorded outcome', () => {
  assert.match(task(), /Never guess, infer, or fill in an answer they did not give/);
  assert.match(task(), /"I don't know" and "we're not sure" are valid outcomes/);
});

test('it can book nothing, order nothing and promise nothing', () => {
  assert.match(task(), /Do not negotiate, book, order, hold, cancel, or promise anything/);
  assert.match(task(), /do not give out or collect personal or payment details/);
});

test('it hangs up on voicemail without leaving a message', () => {
  assert.match(task(), /voicemail, an automated menu, or a disconnected line, end the call without leaving a message/);
});

test('it does not invent a customer', () => {
  assert.match(task(), /Never invent a name, a booking, or a reason on their behalf/);
});

test('the number dialled and the business named are both in the script', () => {
  const t = task();
  assert.ok(t.includes(PHONE));
  assert.ok(t.includes(PLACE.name));
});

test('a Canadian business is not told it is American', () => {
  const ca = task({ place: { country: 'CA' } });
  assert.match(ca, /Canadian business/);
  assert.ok(!ca.includes('local US business'));
});

/* ---- what the agent calls the place ---- */

test('the opener uses a noun that is true of the business', () => {
  assert.equal(placeNoun({ kind: 'restaurant' }), 'restaurant');
  assert.equal(placeNoun({ kind: 'playground' }), 'playground');
  assert.equal(placeNoun({ kind: 'dental clinic' }), 'clinic');
  assert.equal(placeNoun({ kind: 'brewery' }), 'bar');
  assert.equal(placeNoun({ kind: 'art museum' }), 'museum');
});

test('an unknown kind falls through to "place" rather than guessing', () => {
  assert.equal(placeNoun({ kind: 'amusement center' }), 'place');
  assert.equal(placeNoun({}), 'place');
});

test('the kind is trusted over the name, because a name is a proper noun', () => {
  // "Park Wayne Diner" is a diner, not a park
  assert.equal(placeNoun({ kind: 'restaurant', name: 'Park Wayne Diner' }), 'restaurant');
  // only with no kind at all is the name consulted
  assert.equal(placeNoun({ name: 'Park Wayne Diner' }), 'park');
});

test('the opener is one short line ending in a question', () => {
  const o = openerFor({ kind: 'restaurant' });
  assert.equal(o, 'Hi — is now a good moment for one quick question about your restaurant?');
  assert.ok(o.length < 90, 'the opener is short enough not to collide with the greeting');
});

/* ---- templates: the path where no user text reaches the script ---- */

test('templates are fixed strings, each a single factual question', () => {
  assert.ok(TEMPLATES.length >= 10);
  for(const t of TEMPLATES){
    assert.ok(t.id && t.text, 'every template has an id and text');
    assert.match(t.text, /\?$/, `${t.id} ends in a question mark`);
    assert.equal((t.text.match(/\?/g) || []).length, 1, `${t.id} asks one question`);
  }
});

test('every template passes the same validation a typed question does', () => {
  for(const t of TEMPLATES){
    const r = calle.validateQuestion(t.text);
    assert.equal(r.ok, true, `${t.id}: ${r.error}`);
  }
});

test('templates are filtered to the category of the place', () => {
  const food = templatesFor('food');
  assert.ok(food.length > 0);
  assert.ok(food.every(t => TEMPLATES.find(x => x.id === t.id).for.includes('food')));
});

/* ---- the answer schema ---- */

test('the result schema has an explicit unknown rather than forcing a guess', () => {
  assert.deepEqual(RESULT_SCHEMA.properties.answer_status.enum,
    ['answered', 'unclear', 'refused', 'unreachable', 'unknown']);
  assert.equal(RESULT_SCHEMA.additionalProperties, false);
  assert.deepEqual(RESULT_SCHEMA.required, ['answer_status', 'answer', 'evidence_quote']);
});

test('an evidence quote is a required field, not an optional extra', () => {
  assert.ok(RESULT_SCHEMA.required.includes('evidence_quote'));
});

/* ---- the real-call unlock ---- */

test('an empty or wrong access code never unlocks a real call', () => {
  for(const code of ['', null, undefined, 'guess', 'x'.repeat(64)]){
    assert.equal(realCallOk(code), false, `code ${JSON.stringify(code)}`);
  }
});
