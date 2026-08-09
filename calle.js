/* ---- CALL-E integration: "Ask the Place" first-party FAQs ----
   Local Atlas asks a business a single factual question by phone and turns the
   answer into a dated, first-party FAQ entry other visitors can reuse.

   Three constraints drove the shape of this file:

   1. @call-e/calle is ESM-only ("type": "module", no `require` export) and
      server.js is CommonJS, so the SDK is reached through a lazy dynamic
      import() rather than a top-level require. It is also lazy on purpose:
      a deploy without CALLE_API_KEY must still boot and serve the map.
   2. Calls take 30-90 s. Holding an HTTP request open that long dies to
      Render's proxy timeout, so /api/ask-place returns immediately and the
      result arrives by webhook, with polling as the fallback.
   3. Webhook deliveries are NOT signed — the SDK's webhooks.verify() is
      deprecated and documented as legacy-only. A POST to our webhook URL is
      therefore untrusted input: we take only the call id from it and re-read
      the authoritative record from the API before storing anything.

   Call credits are finite, so every path that can dial is rate-limited,
   deduplicated, and budget-capped, and CALLE_DRY_RUN=1 exercises the whole
   flow without dialling. */

const CALLE_KEY = process.env.CALLE_API_KEY || '';
const CALLE_BASE = process.env.CALLE_BASE_URL || '';          // override for staging
const WEBHOOK_TOKEN = process.env.CALLE_WEBHOOK_TOKEN || '';
// Render injects RENDER_EXTERNAL_URL, which is exactly the public origin the
// webhook has to be reachable on, so it works as the default.
const PUBLIC_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const DRY_RUN = process.env.CALLE_DRY_RUN === '1';
const DAILY_BUDGET = parseInt(process.env.CALLE_DAILY_CALL_BUDGET || '25', 10);
const FAQ_TTL_DAYS = parseInt(process.env.CALLE_FAQ_TTL_DAYS || '90', 10);
const CALLER_ID = process.env.CALLE_CALLER_IDENTITY || 'Local Atlas, a local guide app';

const configured = () => !!CALLE_KEY || DRY_RUN;

/* ---- SDK handle (lazy + memoised) ---- */
let _client = null;
async function client(){
  if(_client) return _client;
  if(!CALLE_KEY) throw new Error('CALLE_API_KEY not set');
  const { CalleClient } = await import('@call-e/calle');
  _client = new CalleClient(CALLE_BASE ? { apiKey: CALLE_KEY, baseUrl: CALLE_BASE }
                                       : { apiKey: CALLE_KEY });
  return _client;
}

/* ---- durable record store ----
   Deliberately separate from server.js's cached() helper: that is a
   read-through cache where a miss is free and a lost write is invisible.
   These are records a user is waiting on, so writes are awaited and reported.
   Falls back to memory so the flow is demoable without Upstash. */
const RURL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const mem = new Map();

async function docGet(key){
  if(!RURL){
    const hit = mem.get(key);
    return hit && hit.exp > Date.now() ? hit.v : null;
  }
  const r = await fetch(`${RURL}/get/${encodeURIComponent(key)}`,
    { headers: { Authorization: 'Bearer ' + RTOK } });
  if(!r.ok) throw new Error('store GET HTTP ' + r.status);
  const j = await r.json();
  if(typeof j.result !== 'string') return null;
  try{ return JSON.parse(j.result); }catch(e){ return null; }
}
async function docSet(key, val, ttlMs){
  if(!RURL){ mem.set(key, { v: val, exp: Date.now() + ttlMs }); return; }
  const r = await fetch(`${RURL}/set/${encodeURIComponent(key)}?px=${Math.max(1000, Math.round(ttlMs))}`,
    { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK }, body: JSON.stringify(val) });
  if(!r.ok) throw new Error('store SET HTTP ' + r.status);
}

const DAY = 86400e3;
const faqKey = pk => 'calle:faq:' + pk;              // published answers for a place
const callKey = id => 'calle:call:' + id;            // call id -> pending record
const lockKey = (pk, qh) => `calle:lock:${pk}:${qh}`;// in-flight dedupe
const budgetKey = () => 'calle:budget:' + new Date().toISOString().slice(0, 10);

/* ---- identity + input hygiene ---- */

/* Places arrive from Google, Foursquare or OSM, each with its own id space.
   Prefer a provider id so the FAQ survives a name change; fall back to a
   name+coordinate key so OSM-only places still work. */
function placeKey(p){
  if(p.gid)   return 'g:' + String(p.gid).replace(/[^\w-]/g, '');
  if(p.fsqId) return 'f:' + String(p.fsqId).replace(/[^\w]/g, '');
  const n = String(p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  return `n:${n}:${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
}

/* Providers hand back display formats — Google "(212) 555-0134", OSM
   "+1 212-555-0134", Foursquare "2125550134" — but the API only accepts
   E.164. An extension means a switchboard, so drop it and dial the trunk. */
function normalizeE164(raw){
  if(!raw) return '';
  let s = String(raw).split(/\s*(?:x|ext\.?|extension)\s*\d+/i)[0];
  s = s.replace(/[^\d+]/g, '');
  if(s.startsWith('+')) return /^\+[1-9]\d{6,14}$/.test(s) ? s : '';
  if(s.length === 10) return '+1' + s;                        // NANP: US + Canada
  if(s.length === 11 && s[0] === '1') return '+' + s;
  return '';
}

const qHash = q => normalizeQuestion(q).replace(/[^a-z0-9]/g, '').slice(0, 60);
const normalizeQuestion = q => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');

/* A phone agent can only usefully return facts the person on the phone knows.
   Subjective and review-shaped questions waste a call credit and produce an
   answer no better than the reviews already on the page, so they are refused
   at the door with a nudge toward an answerable rewrite. */
const SUBJECTIVE = /\b(best|worst|good|bad|nice|better|worth it|recommend|should i|favorite|favourite|pretty|romantic|fun|overrated|quality|opinion|like it|tasty|delicious)\b/i;
const UNSAFE = /\b(credit card|social security|ssn|password|discount for me|my order|my reservation|complain|refund|lawsuit|sue|manager'?s name|who owns|home address|cell (phone|number))\b/i;

function validateQuestion(q){
  const s = String(q || '').trim();
  if(s.length < 8)   return { ok: false, error: 'Question is too short — ask something specific.' };
  if(s.length > 180) return { ok: false, error: 'Question is too long — keep it to one factual question.' };
  if(!/\?$/.test(s)) return { ok: false, error: 'Phrase it as a single question ending in "?".' };
  if((s.match(/\?/g) || []).length > 1)
    return { ok: false, error: 'Ask one question per call so the answer stays clear.' };
  /* Two questions welded together — "parking and do you take walk-ins?" — get
     one answer slot and the caller loses half of it. A compound *object*
     ("high chairs and booster seats?") is fine, so require a verb after the
     conjunction rather than rejecting every "and". */
  if(/\b(and|or)\s+(do|does|did|are|is|was|can|could|will|would|should|what|when|where|how|why)\b/i.test(s))
    return { ok: false, error: 'That looks like two questions. Ask one at a time so the answer is unambiguous.' };
  if(SUBJECTIVE.test(s))
    return { ok: false, error: 'That asks for an opinion. Ask a factual question the staff can confirm, like "Do you have high chairs?"' };
  if(UNSAFE.test(s))
    return { ok: false, error: 'That question cannot be asked on your behalf. Ask about the business itself, not an account, order, or person.' };
  return { ok: true, question: s };
}

/* ---- call script ----
   Narrow on purpose: disclose, ask one thing, allow one clarification, take
   "I don't know" as a real answer. The guardrails matter more than coverage —
   this dials real small businesses who did not opt in. */
function buildTask({ place, question, phone }){
  return [
    `Call ${place.name}${place.addr ? ` at ${place.addr}` : ''} on ${phone}.`,
    ``,
    `You are an automated assistant calling on behalf of ${CALLER_ID}. Follow these rules exactly:`,
    `1. Open by saying: "Hi, I'm an AI assistant calling on behalf of ${CALLER_ID}. I have one quick question to confirm a detail on your public listing — is now a good moment?"`,
    `2. If they are busy or ask you to call back, thank them, say you will try later, and end the call. Do not push.`,
    `3. Ask exactly this one question and nothing else: "${question}"`,
    `4. If the answer is ambiguous, you may ask at most one short clarifying follow-up. Do not ask anything unrelated.`,
    `5. Never guess, infer, or fill in an answer they did not give. "I don't know" and "we're not sure" are valid outcomes — record them as unclear.`,
    `6. Do not negotiate, book, order, hold, cancel, or promise anything, and do not give out or collect personal or payment details.`,
    `7. If you reach voicemail, an automated menu, or a disconnected line, end the call without leaving a message.`,
    `8. Thank them and end the call as soon as you have the answer. Keep the whole call under two minutes.`
  ].join('\n');
}

/* String enums with an explicit unknown, per the API's extraction guidance:
   a boolean would force a guess exactly where the call was inconclusive. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer_status', 'answer', 'evidence_quote'],
  properties: {
    answer_status: {
      type: 'string',
      enum: ['answered', 'unclear', 'refused', 'unreachable', 'unknown'],
      description: 'Use answered when a staff member gave a clear factual answer to the question. Use unclear when someone answered the phone but did not know or gave an ambiguous answer. Use refused when they declined to answer. Use unreachable when the call hit voicemail, an automated menu, a disconnected number, or nobody picked up. Use unknown when the evidence does not fit any other value.'
    },
    answer: {
      type: 'string',
      description: 'The factual answer in one or two plain sentences, using only what the business actually said. Do not add detail they did not state. Write exactly "unknown" if answer_status is not answered.'
    },
    evidence_quote: {
      type: 'string',
      description: 'A short direct quote of the staff member\'s own words supporting the answer. Write an empty string if there is no usable quote.'
    },
    staff_confidence: {
      type: 'string',
      enum: ['certain', 'hedged', 'unknown'],
      description: 'Use certain when the staff member answered without hesitation. Use hedged when they guessed, qualified, or deferred to someone else. Use unknown when there is not enough evidence.'
    }
  }
};

/* ---- budget + dedupe ----
   Anything that can dial passes through here first. */
async function reserveBudget(){
  const k = budgetKey();
  const used = (await docGet(k)) || 0;
  if(used >= DAILY_BUDGET) return false;
  await docSet(k, used + 1, 2 * DAY);
  return true;
}

/* ---- public API ---- */

async function askPlace({ place, question }){
  if(!configured()) return { error: 'CALL-E is not configured on this server.', status: 503 };

  const v = validateQuestion(question);
  if(!v.ok) return { error: v.error, status: 400 };

  const phone = normalizeE164(place.phone);
  if(!phone) return { error: 'No callable public phone number is listed for this place.', status: 422 };

  const pk = placeKey(place), qh = qHash(v.question);

  // already answered recently — reuse rather than re-dial
  const faq = (await docGet(faqKey(pk))) || [];
  const known = faq.find(e => e.qHash === qh && e.expiresAt > Date.now());
  if(known) return { status: 200, reused: true, entry: known };

  const lock = await docGet(lockKey(pk, qh));
  if(lock) return { status: 202, callId: lock.callId, state: 'in_progress', deduped: true };

  if(!await reserveBudget())
    return { error: 'Daily call budget reached. Try again tomorrow.', status: 429 };

  const pending = {
    callId: '', placeKey: pk, qHash: qh, question: v.question,
    placeName: place.name, placeAddr: place.addr || '', phone,
    createdAt: Date.now(), state: 'queued'
  };

  if(DRY_RUN){
    pending.callId = 'call_dry_' + Math.random().toString(36).slice(2, 10);
    pending.state = 'in_progress';
    await docSet(callKey(pending.callId), pending, DAY);
    await docSet(lockKey(pk, qh), { callId: pending.callId }, 10 * 60e3);
    return { status: 202, callId: pending.callId, state: 'in_progress', dryRun: true };
  }

  const c = await client();
  const task = buildTask({ place, question: v.question, phone });
  const call = await c.calls.create({
    task,
    recipient: { phone, region: 'US', locale: 'en-US' },
    resultSchema: RESULT_SCHEMA,
    // echoed back on the call and the webhook, so a delivery we did not
    // initiate can be told apart from one we did
    metadata: { app: 'local-atlas', place_key: pk, q_hash: qh, question: v.question },
    ...(webhookUrl() ? { webhookUrl: webhookUrl() } : {})
  }, { idempotencyKey: `local-atlas:${pk}:${qh}` });

  pending.callId = call.id;
  pending.state = call.status;
  await docSet(callKey(call.id), pending, DAY);
  await docSet(lockKey(pk, qh), { callId: call.id }, 10 * 60e3);
  return { status: 202, callId: call.id, state: call.status };
}

function webhookUrl(){
  return PUBLIC_URL && WEBHOOK_TOKEN ? `${PUBLIC_URL}/api/calle/webhook/${WEBHOOK_TOKEN}` : '';
}

/* Poll fallback for when the webhook has not landed (or is not configured at
   all, e.g. local dev behind NAT). Reads the API, never the client. */
async function pollCall(callId){
  const pending = await docGet(callKey(callId));
  if(!pending) return { error: 'Unknown call id.', status: 404 };
  if(pending.state === 'done') return { status: 200, state: 'done', entry: pending.entry };

  if(DRY_RUN){
    // resolve after ~15 s so the UI's waiting state is exercised end to end
    if(Date.now() - pending.createdAt < 15000)
      return { status: 200, state: 'in_progress', callId };
    const entry = await publish(pending, {
      answer_status: 'answered',
      answer: 'Yes — this is a simulated CALL-E answer used for local development.',
      evidence_quote: 'Yes, we do.',
      staff_confidence: 'certain'
    }, { summary: 'Dry-run call', taskCompleted: true, confidence: { score: 1, label: 'high' } });
    return { status: 200, state: 'done', entry };
  }

  const c = await client();
  const call = await c.calls.get(callId);
  if(call.status === 'queued' || call.status === 'in_progress')
    return { status: 200, state: call.status, callId };
  return { status: 200, state: 'done', entry: await ingest(call) };
}

/* Turn a terminal CALL-E record into a published FAQ entry (or a recorded
   failure). Single funnel for both webhook and poll so they cannot diverge. */
async function ingest(call){
  const pending = (await docGet(callKey(call.id))) || {
    callId: call.id,
    placeKey: String(call.metadata?.place_key || ''),
    qHash: String(call.metadata?.q_hash || ''),
    question: String(call.metadata?.question || ''),
    placeName: '', placeAddr: '', phone: '', createdAt: Date.now()
  };
  if(!pending.placeKey || !pending.qHash) throw new Error('call is missing place metadata');

  const r = call.structuredResult || {};
  const attempt = call.recipients?.[0]?.attempts?.slice(-1)[0] || null;
  return publish(pending, r, {
    summary: call.summary || '',
    taskCompleted: call.taskCompleted,
    confidence: call.completionConfidence || null,
    transcript: attempt?.transcriptTurns || [],
    failureCode: call.failureCode || null,
    failureMessage: call.failureMessage || null,
    status: call.status
  });
}

async function publish(pending, result, meta){
  const now = Date.now();
  const answered = result.answer_status === 'answered';
  const entry = {
    qHash: pending.qHash,
    question: pending.question,
    answer: answered ? String(result.answer || '') : '',
    answerStatus: result.answer_status || 'unknown',
    evidenceQuote: String(result.evidence_quote || ''),
    staffConfidence: result.staff_confidence || 'unknown',
    source: 'first_party_phone',
    callId: pending.callId,
    collectedAt: now,
    // only a real answer earns a long life; everything else is retryable soon
    expiresAt: now + (answered ? FAQ_TTL_DAYS : 1) * DAY,
    summary: meta.summary || '',
    confidence: meta.confidence || null,
    transcript: (meta.transcript || []).slice(0, 60),
    failureCode: meta.failureCode || null,
    failureMessage: meta.failureMessage || null
  };

  const key = faqKey(pending.placeKey);
  const faq = (await docGet(key)) || [];
  const next = faq.filter(e => e.qHash !== entry.qHash);
  // answered entries lead; the list is small and read far more than written
  next.unshift(entry);
  await docSet(key, next.slice(0, 40), (FAQ_TTL_DAYS + 30) * DAY);

  await docSet(callKey(pending.callId), { ...pending, state: 'done', entry }, DAY);
  // a failed call should be retryable immediately, so release the dedupe lock
  if(!answered) await docSet(lockKey(pending.placeKey, pending.qHash), null, 1000);
  return entry;
}

/* Webhook body is unsigned and therefore untrusted: take the id, verify the
   shared-secret path token, then re-read the call from the API and store that.
   A forged POST can at worst cost us one authenticated GET. */
async function handleWebhook({ token, body }){
  if(!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) return { status: 401, error: 'bad token' };
  const id = String(body?.data?.id || '');
  if(!/^call_[\w-]+$/.test(id)) return { status: 400, error: 'bad call id' };
  const c = await client();
  const call = await c.calls.get(id);
  if(call.status === 'queued' || call.status === 'in_progress')
    return { status: 200, ignored: 'not terminal' };
  await ingest(call);
  return { status: 200 };
}

async function getFaq(place){
  const faq = (await docGet(faqKey(placeKey(place)))) || [];
  return faq.filter(e => e.expiresAt > Date.now() || e.answerStatus === 'answered');
}

module.exports = {
  configured, askPlace, pollCall, handleWebhook, getFaq,
  placeKey, normalizeE164, validateQuestion, buildTask, RESULT_SCHEMA,
  info: () => ({
    configured: configured(), dryRun: DRY_RUN,
    webhook: !!webhookUrl(), budget: DAILY_BUDGET, ttlDays: FAQ_TTL_DAYS
  })
};
