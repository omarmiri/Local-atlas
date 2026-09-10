/* "Nothing is dialled outside 10:00-20:00 local to the business being called."
   The clock is frozen for these, so the assertion is about the rule and not
   about what time the suite happened to run. */
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { calle } = require('./helpers');
const { zoneFor, localHour, insideCallingWindow, countryOf } = calle;

const at = (place) => ({ lat: place[0], lon: place[1] });
const NEW_YORK   = [40.7128,  -74.0060];
const TORONTO    = [43.6532,  -79.3832];
const CHICAGO    = [41.8781,  -87.6298];
const DENVER     = [39.7392, -104.9903];
const PHOENIX    = [33.4484, -112.0740];
const VANCOUVER  = [49.2827, -123.1207];
const HONOLULU   = [21.3069, -157.8583];
const ANCHORAGE  = [61.2181, -149.9003];
const HALIFAX    = [44.6488,  -63.5752];
const ST_JOHNS   = [47.5615,  -52.7126];

test('coordinates resolve to the zone the business is actually in', () => {
  assert.equal(zoneFor(...NEW_YORK),  'America/New_York');
  assert.equal(zoneFor(...TORONTO),   'America/New_York');
  assert.equal(zoneFor(...CHICAGO),   'America/Chicago');
  assert.equal(zoneFor(...DENVER),    'America/Denver');
  assert.equal(zoneFor(...VANCOUVER), 'America/Los_Angeles');
  assert.equal(zoneFor(...HONOLULU),  'Pacific/Honolulu');
  assert.equal(zoneFor(...ANCHORAGE), 'America/Anchorage');
  assert.equal(zoneFor(...HALIFAX),   'America/Halifax');
  assert.equal(zoneFor(...ST_JOHNS),  'America/St_Johns');
});

test('Arizona keeps standard time all year and gets its own zone', () => {
  assert.equal(zoneFor(...PHOENIX), 'America/Phoenix');
});

test('10am Eastern is not 10am anywhere else — the bug this rule exists for', () => {
  // 15:00 UTC on a winter morning: 10:00 in New York, 07:00 on the west coast,
  // 05:00 in Honolulu. A single Eastern clock would have dialled all three.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-15T15:00:00Z') });
  try{
    assert.equal(localHour(...NEW_YORK), 10);
    assert.equal(insideCallingWindow(at(NEW_YORK)), true,  'New York at 10:00 is inside');

    assert.equal(localHour(...VANCOUVER), 7);
    assert.equal(insideCallingWindow(at(VANCOUVER)), false, 'Vancouver at 07:00 is not');

    assert.equal(localHour(...HONOLULU), 5);
    assert.equal(insideCallingWindow(at(HONOLULU)), false, 'Honolulu at 05:00 is not');
  } finally { mock.timers.reset(); }
});

test('and 6pm Pacific is a civil hour, which one Eastern clock refused', () => {
  // 02:00 UTC: 18:00 in Vancouver, 21:00 in New York.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-16T02:00:00Z') });
  try{
    assert.equal(insideCallingWindow(at(VANCOUVER)), true,  'Vancouver at 18:00 is inside');
    assert.equal(insideCallingWindow(at(NEW_YORK)),  false, 'New York at 21:00 is past the window');
  } finally { mock.timers.reset(); }
});

test('the window is closed at both ends', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-15T14:59:00Z') });
  try{ assert.equal(insideCallingWindow(at(NEW_YORK)), false, '09:59 is too early'); }
  finally { mock.timers.reset(); }

  mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-16T00:00:00Z') });
  try{ assert.equal(insideCallingWindow(at(NEW_YORK)), true, '19:00 is the last hour in'); }
  finally { mock.timers.reset(); }

  mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-16T01:00:00Z') });
  try{ assert.equal(insideCallingWindow(at(NEW_YORK)), false, '20:00 is out'); }
  finally { mock.timers.reset(); }
});

test('a listing with no coordinates still yields an hour rather than a crash', () => {
  for(const bad of [[NaN, NaN], [undefined, undefined], ['x', 'y']]){
    const h = localHour(Number(bad[0]), Number(bad[1]));
    assert.ok(Number.isInteger(h) && h >= 0 && h < 24, `got ${h}`);
  }
});

test('a Canadian listing is a Canadian call, and anything else is US', () => {
  assert.equal(countryOf({ country: 'CA' }), 'CA');
  assert.equal(countryOf({ country: 'ca' }), 'CA');
  assert.equal(countryOf({ country: 'US' }), 'US');
  assert.equal(countryOf({}), 'US');
  assert.equal(countryOf(null), 'US');
});
