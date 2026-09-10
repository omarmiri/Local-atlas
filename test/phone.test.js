/* normalizeE164 answers "is this a phone number".
   dialable answers "is this a number this app has any business ringing". */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calle } = require('./helpers');
const { normalizeE164: n, dialable: d } = calle;

test('every provider display format reaches the same E.164 number', () => {
  for(const raw of ['(212) 555-0134', '+1 212-555-0134', '2125550134',
                    '12125550134', '212.555.0134', ' +1 (212) 555 0134 ']){
    assert.equal(n(raw), '+12125550134', `from ${raw}`);
  }
});

test('an extension means a switchboard, so the trunk is dialled', () => {
  assert.equal(n('(212) 555-0134 x27'), '+12125550134');
  assert.equal(n('212-555-0134 ext. 9'), '+12125550134');
});

test('what is not a number at all normalises to nothing', () => {
  for(const raw of ['', null, undefined, 'call us!', '911', '411', '555-0134']){
    assert.equal(n(raw), '', `from ${JSON.stringify(raw)}`);
  }
});

test('emergency and service codes cannot survive normalisation', () => {
  for(const code of ['911', '988', '411', '112']) assert.equal(n(code), '');
});

test('this app calls the US and Canada, and nowhere else', () => {
  assert.equal(d('+12125550134').ok, true);           // New York
  assert.equal(d('+19025550134').ok, true);           // Nova Scotia
  const uk = d(n('+447700900123'));                   // normalises fine, still refused
  assert.equal(uk.ok, false);
  assert.match(uk.why, /US and Canadian/);
});

test('premium rate is refused in both of its shapes', () => {
  // 900 is an area code
  assert.equal(d('+19005550134').ok, false);
  // 976 is an exchange — the middle three digits
  assert.equal(d('+12129761234').ok, false);
});

test('976 as an area code is not premium rate and is not blocked', () => {
  // the bug the pattern was corrected for: matching 976 in the wrong position
  // blocked a real area code and let every real 976 exchange through
  assert.equal(d('+19765550134').ok, true);
});

test('nothing at all is refused with a reason', () => {
  const r = d('');
  assert.equal(r.ok, false);
  assert.match(r.why, /not a phone number/);
});
