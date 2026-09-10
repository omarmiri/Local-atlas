/* Shared setup for the test suite.
   Nothing in test/ modifies application code. Every test imports the real
   modules and exercises the exported functions as the server does.

   The environment is pinned before calle.js is required, because that module
   reads its configuration once at load. CALLE_DRY_RUN=1 is belt and braces:
   no test here reaches a code path that could dial, but a suite that runs on
   a developer's machine should not be one typo away from spending a credit. */
process.env.CALLE_DRY_RUN = '1';
delete process.env.CALLE_API_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;   // store.js falls back to memory

const crypto = require('crypto');
const calle = require('../calle');

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/* A place shaped the way server.js hands one to calle.js. */
const PLACE = { gid: 'ChIJtest0001', name: "Rosa's Pizzeria", addr: '12 Main St',
                kind: 'restaurant', lat: 40.7128, lon: -74.0060, country: 'US' };

const QUESTION = 'Do you have high chairs for young children?';
const PHONE = '+12125550134';

/* A matching pending/call pair that binds cleanly, so each test can break
   exactly one thing and assert that the break is what gets refused. */
function boundPair(over = {}){
  const place = { ...PLACE, ...(over.place || {}) };
  const question = over.question || QUESTION;
  const phone = over.phone || PHONE;
  const task = calle.buildTask({ place, question, phone });
  const priv = !!over.private;

  const pending = {
    callId: 'call_test_1', placeKey: calle.placeKey(place), qHash: qh(question),
    taskHash: sha256(task), question, phone, private: priv,
    uid: priv ? 'user_1' : null, ...(over.pending || {})
  };
  const call = {
    id: 'call_test_1', status: 'completed', task,
    metadata: { app: 'local-atlas', place_key: calle.placeKey(place), q_hash: qh(question),
                question, visibility: priv ? 'private' : 'public', ...(over.metadata || {}) },
    recipients: over.recipients || [
      /* The number we asked for is deliberately not first — bindResult must
         match on the number, not on recipients[0]. */
      { phones: ['+12125559999'], attempts: [{ phone: '+12125559999', status: 'no-answer' }] },
      { phones: [phone], attempts: [{ phone, status: 'completed' }] }
    ],
    ...(over.call || {})
  };
  return { place, question, phone, task, pending, call };
}

/* calle.js's qHash is internal; this mirrors it so a test can build a pending
   record the binder will accept. If the two ever diverge, the happy-path
   binding tests fail loudly, which is the intended alarm. */
const qh = q => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ')
  .replace(/[^a-z0-9]/g, '').slice(0, 60);

module.exports = { calle, sha256, qh, PLACE, QUESTION, PHONE, boundPair };
