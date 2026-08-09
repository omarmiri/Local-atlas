# Local Atlas × CALL-E — implementation plan

First-party FAQs: a visitor asks one factual question about a place, CALL-E phones the
business, and the answer becomes a dated, reusable FAQ entry on the place page.

Status legend: **[done]** shipped and verified on the live host · **[next]** not started.

---

## 0. What already exists (before CALL-E)

Local Atlas is a deployed Express app (`server.js`, ~1200 lines) serving a single-file
frontend (`index.html`) on Render, with an Upstash Redis read-through cache.

The two facts that matter most for this integration:

- **Phone numbers already flow through the places pipeline.** The Google nearby-search
  field mask includes `places.nationalPhoneNumber`, Foursquare contributes `tel`, and OSM
  contributes `contact:phone`. `mergePlaces()` preserves `phone` across providers, so most
  places already arrive with a callable number. This was the single biggest unknown and it
  resolved in our favour — no new provider work is needed to get phone coverage.
- **Open/closed state is already computed** (`openNow` from Google/Foursquare, `isOpenNow()`
  parsing OSM hours). Section 3 spends this for free.

---

## 1. Backend integration — **[done]**

Committed in `4049cfc`, live on `local-atlas-api.onrender.com`.

**`calle.js`** — the whole CALL-E subsystem, kept out of `server.js` because it is a
coherent unit with its own storage and failure modes.

**Routes wired in `server.js`:**

| Route | Purpose |
|---|---|
| `POST /api/ask-place` | Validate, dedupe, budget-check, create the call. Returns `202 {callId}`. |
| `GET /api/ask-place/:id` | Poll fallback for the result. |
| `POST /api/place-faq` | Published FAQ entries for a place. |
| `POST /api/calle/webhook/:token` | Terminal-event receiver. |
| `GET /api/health` | Now reports `calle: {configured, dryRun, webhook, budget, ttlDays}`. |

### Three constraints that shaped the design

1. **The SDK is ESM-only** (`"type": "module"`, no `require` export) and `server.js` is
   CommonJS. It is reached through a lazy `await import('@call-e/calle')`, memoised after
   first use. Lazy also means a deploy without `CALLE_API_KEY` still boots and serves the
   map — verified live: `calle.configured` is `false` while every other health flag is `true`.
2. **Calls take 30–90 s**, which is longer than Render's proxy will hold a request. So
   `/api/ask-place` returns a call id immediately; the answer arrives by webhook, with
   polling as the fallback for local dev behind NAT.
3. **CALL-E webhooks are unsigned** — the SDK's `webhooks.verify()` is explicitly deprecated
   as legacy-only. A POST to our webhook URL is therefore untrusted input. The receiver
   takes *only the call id* from the body, guards on a secret path token, and re-reads the
   authoritative record from the API before storing anything. A forged POST costs us one
   authenticated GET and nothing else.

### Guardrails in the call script

Disclose AI identity up front → ask if it's a good moment → back off immediately if busy →
ask **exactly one** question → at most one clarifying follow-up → never guess (`"I don't
know"` is a valid recorded outcome) → never book, order, or promise anything → hang up on
voicemail/IVR without leaving a message → under two minutes.

### Question validation (protects call credits and the businesses)

Rejects, with a rewrite nudge: subjective/review-shaped asks (*"is this the best pizza?"*),
compound questions (*"parking **and** walk-ins?"* — one answer slot, half an answer),
account-specific asks (*"where's my order?"*), and anything unphrased as a single question.

### Credit protection

Per-day budget cap (`CALLE_DAILY_CALL_BUDGET`, default 25) · in-flight dedupe so two users
asking the same thing share one call · answered questions reuse the stored FAQ instead of
re-dialling · idempotency key `local-atlas:<placeKey>:<qHash>` so a retry can't double-dial ·
**`CALLE_DRY_RUN=1` exercises the entire flow without dialling.**

### Result schema

String enums with an explicit `unknown` (per CALL-E's extraction guidance — a boolean would
force a guess exactly where the call was inconclusive):

- `answer_status`: `answered | unclear | refused | unreachable | unknown`
- `answer`: one or two plain sentences, only what the business actually said
- `evidence_quote`: short direct quote in the staff member's own words
- `staff_confidence`: `certain | hedged | unknown`

Only `answered` earns the full 90-day TTL; everything else expires in a day so it's
immediately retryable.

### Verified end to end

Against a mock API that captures the wire payload: the request matches the OpenAPI
`CreateCallRequest` exactly (E.164 recipient, `result_schema`, `metadata`, `webhook_url`,
Bearer auth, `Idempotency-Key`). Webhook delivery → structured answer + transcript →
published FAQ → re-ask reuses without dialling. Live: unconfigured guard returns 503,
unauthenticated webhook returns 401.

---

## 2. Before the first real call — **[next, ~15 min]** ⚠️ blocking

Set in the **Render dashboard** (`render.yaml`'s `generateValue` only applies on a fresh
blueprint sync, so an existing service won't pick it up):

- `CALLE_API_KEY` — from https://dashboard.heycall-e.com/account/api-keys
- `CALLE_WEBHOOK_TOKEN` — any long random string; it is the only thing making the webhook
  URL unguessable

Then confirm `/api/health` shows `calle.configured: true` and `calle.webhook: true`
(`webhook` requires `RENDER_EXTERNAL_URL`, which Render injects automatically).

**Do the first live call against a phone you own**, not a business. Authenticate the CLI
(`npm install -g @call-e/cli`, `calle auth login`) if you want to watch call state
independently of the app.

---

## 3. Don't dial closed businesses — **[next, ~30 min]** — highest value per minute of work

The app *already knows* whether a place is open (`openNow`, `isOpenNow(hours)`). Gate
`askPlace()` on it: if closed, skip the call and return "we'll ask when they reopen" rather
than burning a credit on a call nobody answers.

This directly addresses the "business availability" risk in the project description, costs
almost nothing because the data is already on the object, and removes the most likely cause
of a wasted credit during judging. Add a courtesy window too (no calls before 10:00 or after
20:00 local, never during a restaurant's lunch rush).

---

## 4. Frontend — **[next, ~3–4 h]** — the largest remaining piece

All of it lands in `index.html`, in and around `poiDetailHTML(it, idx)` (~line 1738), which
already renders the expanded place card and is where `it.phone` is displayed today.

1. **"Ask the Place" button** in the `.poi-actions` chip row, shown only when
   `normalizeE164(it.phone)` would succeed. Opens a focused question form.
2. **Suggested question templates** as chips, category-aware — restaurants get *high chairs
   / walk-ins / outdoor seating*, parks get *stroller-friendly / restrooms / parking*,
   attractions get *outside food / reservations*. This is the cheapest lever on answer
   quality: templates are pre-validated, so users can't waste a credit on a subjective
   question. Keep a free-text box alongside it and log which people choose — that's one of
   the stated learning goals, and it answers itself if you instrument it.
3. **Waiting state** — poll `GET /api/ask-place/:id` every 5 s with a clear "calling now…"
   affordance. A phone call is slow; make the wait legible rather than hiding it.
4. **First-party FAQ panel** — rendered from `POST /api/place-faq`, visually distinct from
   reviews and AI recommendations. Each entry shows the answer, the **"Confirmed <date>"**
   stamp, an expandable transcript, and a source label. `unclear`/`unreachable` outcomes
   should show honestly ("we called, they weren't sure") — that transparency is a feature,
   and it's what separates this from a review scrape.

Everything the panel needs is already in the stored entry: `answer`, `evidenceQuote`,
`collectedAt`, `expiresAt`, `transcript`, `confidence`, `answerStatus`.

---

## 5. Freshness + moderation — **[next, ~1–2 h]**

- **Freshness labels** from `collectedAt`/`expiresAt`: *Confirmed today* · *Confirmed this
  month* · *Needs recheck*. The data is stored; this is presentation only.
- **Recheck button** on stale entries → re-runs `askPlace` (dedupe already allows it once
  the entry expires).
- **Admin view** at `/admin?token=…` listing failed, `unclear`, and `unreachable` calls with
  transcripts. Useful during judging as a "here's what actually happened" exhibit, and it's
  the honest way to show the failure modes rather than only demoing the happy path.

---

## 6. Demo strategy — plan the credits

Curate **5–8 real local places** you have verified: currently open, a working direct number
(not a call centre), and a question whose answer isn't already on their website. Call each
one **before** the demo so the FAQ panel is already populated with real answers — then the
live demo is one fresh call against a known-good target, with a populated page as the
fallback if it goes to voicemail.

Best-performing question shapes, roughly in order: **binary amenity** (*"Do you have high
chairs?"*) → **policy** (*"Do you take walk-ins on Saturday?"*) → **logistics** (*"Is there
parking on site?"*). Avoid anything requiring a manager or a lookup.

A call that hits voicemail and gets recorded as `unreachable` is a *successful*
demonstration of the guardrails — it shows the agent hangs up rather than inventing an
answer. Frame it that way rather than treating it as a failure.

---

## 7. Judgement calls worth being deliberate about

- **You are dialling real small businesses who did not opt in.** The disclosure-first script
  and the one-question limit are the ethical core of this project, not decoration. Keep the
  call volume low and the allowlist curated; a demo that spams local restaurants is a worse
  outcome than a demo with three answers in it.
- **Don't let the agent become an assistant.** The script forbids booking, ordering, and
  promising. Widening that after the hackathon (the "actionable local workflows" idea) is a
  much bigger consent and liability question than adding a feature.
- **`n:`-prefixed place keys are coordinate-based** and will drift if a provider nudges a
  pin. Fine for the hackathon; if OSM-only places matter later, geohash-bucket the key.
- **Deferred deliberately:** Goals API (`/v1/goals`) for reusable call templates — the
  one-off calls API is the right fit for arbitrary user questions, but Goals would be the
  natural home for the fixed question templates in §4.2 if you want per-template analytics.

---

## Sequence

§2 (blocking, 15 min) → §3 (30 min, protects credits) → §4 (3–4 h, the demo itself) →
§6 curation and pre-calls → §5 if time allows.

§4 is the critical path. §3 before §4 so that early manual testing doesn't waste credits on
closed businesses.
