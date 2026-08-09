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

## 2. Environment — **[done, except the webhook token]**

Set in the **Render dashboard** (`render.yaml`'s `generateValue` only applies on a fresh
blueprint sync, so an existing service won't pick it up). Every CALL-E setting is read under
**both** `CALLE_FOO` and `CALL-E-FOO`, because the key was deployed hyphenated and a
hyphenated name cannot be reached by `process.env.CALLE_API_KEY` dot-access.

| Variable | State |
|---|---|
| `CALL-E-API-KEY` | set ✅ |
| `CALL-E-DRY-RUN=1` | **set this while building** — simulates every call, dials nothing |
| `CALL-E-WEBHOOK-TOKEN` | not set; any long random string, the only thing making the webhook URL unguessable |
| `CALL-E-ACCESS-CODE` | not set — and while it is unset, every real call attempt is refused |

⚠️ **The access code and the dry-run flag are the only two things standing between a chip
click and a real phone ringing.** With no access code the feature is closed, which is the
safe default. Setting an access code *without* `CALL-E-DRY-RUN=1` arms real dialling.

**Do the first live call against a phone you own**, not a business. Authenticate the CLI
(`npm install -g @call-e/cli`, `calle auth login`) if you want to watch call state
independently of the app.

### There is no vendor sandbox — we simulate locally instead

Checked and ruled out: the OpenAPI spec exposes a single production server and no test flag
on `POST /v1/calls`, and `test-api.heycall-e.com` is a live staging mirror that still dials a
real phone and wants its own key.

So `CALLE_DRY_RUN=1` is the sandbox, and it now earns the name. It runs the entire pipeline
— validation, moderation, dedupe, budget, publish, FAQ storage — against **any** place with
a callable number, and produces a transcript in the same `CallTranscriptTurn` shape the real
API returns, so nothing downstream can tell a simulated call from a real one. Gemini writes
the dialogue from the actual place and question; without a Gemini key it falls back to a
locally built transcript, because a simulator that needs a second API to work isn't one.

Outcomes are weighted rather than always-success (74% `answered`, 13% `unclear`, 8%
`unreachable`, 5% `refused`) and are deterministic in place+question, so a given card behaves
the same way every time it's opened during a demo. `CALLE_SIM_OUTCOME` pins one outright;
`CALLE_SIM_DURATION_MS` shortens the fake 18-second call.

This is why no fake shop or throwaway number had to be arranged: every POI on the explorer
page that carries a phone number is already a valid target.

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

## 4. Frontend — **[done]**

All of it lands in `index.html`, in and around `poiDetailHTML(it, idx)`, which renders the
expanded place card and is where `it.phone` is displayed.

1. **"Stored answered questions" button** in the `.poi-actions` chip row, shown only when the
   backend reports CALL-E configured and the place has a 10+ digit number. Toggles the panel.
2. **Question chips** — Gemini proposes place-specific questions (`POST /api/ask-suggestions`),
   the fixed `TEMPLATES` follow as the floor. A generated question is *not* trusted for having
   been generated: each one goes back through the same `validateQuestion()` gate free text
   does, and anything that fails is dropped rather than shown as a chip. Generated chips carry
   no template id, so asking one takes the untrusted path and is moderated again at call time.
   Free-text box alongside, refused with a rewrite nudge when it fails.
3. **Waiting state** — polls `GET /api/ask-place/:id` every 5 s behind a "Calling <place>
   now…" spinner, giving up after 3 minutes rather than spinning forever.
4. **Answered-questions panel** — read-first, because the common case is that someone already
   asked. Each entry shows the answer, the evidence quote, a **"Confirmed today / N days ago /
   Needs recheck"** stamp, an expandable **call log** with agent/staff turns, and an **Ask
   again** button on stale or unanswered entries. `unclear`/`unreachable`/`refused` render
   honestly ("we called, they weren't sure") rather than being dropped — that transparency is
   what separates this from a review scrape.
5. **Simulated answers say so**, on the entry and in the panel footer. `publish()` stamps
   `simulated` onto the FAQ entry. A simulated answer presented as a real one is the one thing
   this feature must never do.

Everything the panel needs was already in the stored entry: `answer`, `evidenceQuote`,
`collectedAt`, `expiresAt`, `transcript`, `confidence`, `answerStatus`.

---

## 5. Freshness + moderation — **[mostly done]**

- **Freshness labels** and the **Ask again** button shipped with §4.
- **[next]** **Admin view** at `/admin?token=…` listing failed, `unclear`, and `unreachable`
  calls with transcripts. Useful during judging as a "here's what actually happened" exhibit,
  and it's the honest way to show the failure modes rather than only demoing the happy path.

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

§1, §2 and §4 are done; the whole loop runs against the simulator on any POI with a phone.

Remaining, in order: **§3** (don't dial closed businesses — 30 min, and it must land before
the first real call, not after) → set `CALL-E-WEBHOOK-TOKEN` and `CALL-E-ACCESS-CODE` and
drop `CALL-E-DRY-RUN` → §6 curation and pre-calls → §5 admin view if time allows.
