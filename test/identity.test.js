/* What a stored answer is filed under. A key that moves when a business
   renames itself loses every fact already collected about it. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calle } = require('./helpers');
const { placeKey, providerRef } = calle;

test('a provider id is preferred, so a renamed business keeps its facts', () => {
  const before = { gid: 'ChIJabc123', name: "Rosa's Pizzeria", lat: 40.7, lon: -74 };
  const after  = { gid: 'ChIJabc123', name: 'Rosa Trattoria',  lat: 40.7, lon: -74 };
  assert.equal(placeKey(before), placeKey(after));
  assert.equal(placeKey(before), 'g:ChIJabc123');
});

test('each provider gets its own namespace', () => {
  assert.equal(placeKey({ gid: 'abc' }), 'g:abc');
  assert.equal(placeKey({ fsqId: 'def' }), 'f:def');
  assert.equal(placeKey({ osmId: 'node/1' }), 'o:node1');
});

test('a listing naming two sources gets a key of its own, not either of theirs', () => {
  const both = placeKey({ gid: 'abc', fsqId: 'def' });
  assert.equal(both, 'x:f:def+g:abc');
  assert.notEqual(both, placeKey({ gid: 'abc' }));
  assert.notEqual(both, placeKey({ fsqId: 'def' }));
});

test('the two-source key does not depend on the order they were sent in', () => {
  assert.equal(placeKey({ gid: 'abc', fsqId: 'def' }),
               placeKey({ fsqId: 'def', gid: 'abc' }));
});

test('a listing with no id at all falls back to name and coordinates', () => {
  const k = placeKey({ name: "Rosa's Pizzeria", lat: 40.7128, lon: -74.006 });
  assert.equal(k, 'n:rosaspizzeria:40.7128,-74.0060');
});

test('providerRef reports every id the listing carries', () => {
  const refs = providerRef({ gid: 'abc', fsqId: 'def', osmId: 'way/9' });
  assert.deepEqual(refs.map(r => r.kind), ['g', 'f', 'o']);
});
