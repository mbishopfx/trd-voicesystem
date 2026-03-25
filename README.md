# Outbound Voice Bot (Vapi + Twilio-Aware Dialer)

Production starter for a daily CSV-fed outbound dialer that:

- Ingests warm leads from `data/incoming/*.csv`
- Enforces rate limits (effective CPS = min of system, Twilio CPS, Vapi RPS)
- Places outbound calls through Vapi `/call`
- Enforces 3-minute call cap and on-topic guardrails
- Ends immediately on voicemail/answering-machine detection (no voicemail drop)
- Sends booking-link SMS follow-up on voicemail outcomes (when Twilio + booking URL are configured)
- Syncs to GoHighLevel only after a call attempt, tagged with `jarvis-voice`
- Adds call transcript/outcome into GHL notes after call completion
- Handles booking events from Calendly and Google Calendar webhooks
- Includes an advanced Template Studio for rule packs, rebuttal libraries, prompt compile, and Vapi draft payload export
- Includes analytics/stats summary endpoints and dashboard metrics for call funnel conversion
- Includes Vapi Tools Manager (catalog + custom tool CRUD + assistant toolId attachment)
- Includes inbound profile builder with phase tracking + phone number routing attach flow
- Includes primary-agent control UX and secondary additional-agent provisioning (requires number assignment)
- Includes GHL Smart List import endpoint (filterId -> CSV -> ingest)
- Exports retarget CSV buckets for `no_answer`, `answered_hung_up`, and `voicemail` outcomes
- Includes dashboard CSV upload + ingest controls for daily lead drops
- Includes booking validation controls (Calendly/Google source tagging test)
- Includes stuck-dialing recovery control (`/api/dialer/reset-stuck`) for operational resets

## Architecture

1. `src/ingest.ts`
- Reads all incoming CSVs daily.
- Normalizes numbers to E.164.
- Enforces DNC safeguards and optional opt-in requirements (`REQUIRE_OPT_IN` + `TRUST_ALL_IMPORTS`).
- Deduplicates by phone-derived lead ID.

2. `src/worker.ts`
- Pulls due leads from queue state.
- Respects call windows by lead timezone.
- Applies token-bucket CPS throttling.
- Applies a post-call pacing delay before dialing the next lead (`POST_CALL_DELAY_SECONDS`, default 30s).
- Creates outbound calls via Vapi and retries retriable failures.
- Optionally syncs to GoHighLevel immediately on call attempt (`GHL_SYNC_ON_CALL_ATTEMPT=true`).

3. `src/server.ts`
- Receives Vapi end-of-call events.
- Stores outcome + transcript (except no-contact outcomes).
- Sends booking-link SMS on win outcomes (`booked`, `callback_requested`) when enabled.
- Sends booking-link SMS on voicemail outcomes to keep follow-up moving.
- Writes transcript notes to GHL contact record.
- Handles Calendly and Google booking webhooks.
- Auto-refreshes retarget CSV bucket files for retarget-eligible outcomes (`no_answer`, `answered_hung_up`, `voicemail`).

4. `public/index.html`
- React + Tailwind operations dashboard for campaign run control, 5-second log streaming, and call artifact review.

5. `src/agentTemplates.ts` + `src/templateStore.ts`
- Defines advanced agent template schema and rule packs.
- Supports template-level knowledge base facts for more accurate offer/rebuttal behavior.
- Compiles high-discipline system prompts from template inputs.
- Scores template quality and exports Vapi assistant draft payloads.

6. `src/analytics.ts`
- Computes totals, rates, outcomes, and daily trend stats from lead/call state.

7. `src/integrations/vapiTools.ts` + `src/toolCatalog.ts`
- Tool CRUD against Vapi `/tool` endpoints.
- Assistant toolId attach/update controls.
- Catalog guidance for API-supported vs dashboard-assisted tools.

8. `src/inboundStore.ts` + `src/integrations/vapiPhoneNumbers.ts`
- Persistent inbound agent profile state (assistant, number, booking handoff, guardrails).
- Inbound rollout phase status generation for dashboard.
- Vapi phone number list/get/update helpers for inbound routing attach.

## Install

```bash
npm install
cp .env.example .env
```

## Required env for test call

- `VAPI_API_KEY`
- `VAPI_PHONE_NUMBER_ID` (or Twilio fallback below)
- `VAPI_ASSISTANT_ID` or both `VAPI_ASSISTANT_ID_FEMALE` + `VAPI_ASSISTANT_ID_MALE`

Twilio fallback (if Vapi phone number UUID is unavailable):

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`

## Recommended env for booking and CRM tracking

- `BOOKING_URL_CALENDLY`
- `BOOKING_URL_GOOGLE_CALENDAR`
- `BOOKING_PROVIDER=calendly|google`
- `GHL_API_KEY`
- `GHL_LOCATION_ID`
- `GHL_SYNC_ON_CALL_ATTEMPT=false` (default: wait for call completion so transcript note is included)
- `CALENDLY_WEBHOOK_SIGNING_KEY` (recommended)
- `GOOGLE_CALENDAR_WEBHOOK_SECRET` (recommended)
- `RETARGET_AUTO_EXPORT=true` (recommended)
- `WIN_SMS_ENABLED=true` (recommended)
- `WIN_SMS_TEMPLATE=...` (supports `{{firstName}}`, `{{bookingUrl}}`, `{{campaignName}}`)
- `PROSPECTOR_WIN_SMS_TEMPLATE=...` (supports `{{firstName}}`, `{{liveLink}}`, `{{bookingUrl}}`, `{{campaignName}}`)
- `TRUST_ALL_IMPORTS=true` (recommended when uploaded/imported lists are already approved to call)
- `VAPI_PROSPECTOR_ASSISTANT_ID` (required for Prospector phase 5 specialized calling)
- `GEMINI_PROSPECTOR_MODEL=gemini-3.0-flash` (recommended for Prospector landing page generation)
- `PROSPECTOR_GHL_AUTO_SYNC=true` (auto-create/sync Prospector contacts + notes/tags)
- `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` (Google Maps/Places + Search enrichment)
- `XAI_API_KEY` (optional lead-scoring/enrichment fallback chain)
- `FIRECRAWL_API_KEY` (optional website scrape enrichment for contact + positioning signals)

## Recommended env for persistent cloud state

- `DATABASE_URL` (Supabase Postgres connection string)

## Run

All-in-one:

```bash
npm run dev
```

Or split:

```bash
npm run ingest
npm run worker
npm run server
```

Dashboard:

- Open `http://localhost:3000/dashboard`
- Use **Operator Quick Start** checklist for daily run readiness
- Use **Script Variables** to define `key=value` assistant variable overrides for test calls
- Attach connection values
- Build/select advanced templates in Template Studio
- Compile prompt + inspect quality score
- Generate Vapi assistant draft payload
- Publish selected template directly to Vapi from the dashboard
- View analytics metrics (attempted, booked, rates, outcomes, daily trend)
- Build custom tools and attach them to assistants from Tools Manager
- Use **Agent Onboarding** wizard to create a new assistant, tune tone/script, and assign a phone number
- Upload CSVs and ingest immediately into dialer queue from dashboard
- Validate booking flow via booking test controls (Calendly recommended for first pass)
- Place a manual test call using selected template

Sample smoke CSV (provided in repo):

- `data/test/full-scope-smoke.csv`

## Webhook endpoints to register

- Vapi: `POST /webhooks/vapi`
- Booking (generic/manual): `POST /webhooks/meeting-booked`
- Calendly: `POST /webhooks/calendly`
- Google Calendar bridge: `POST /webhooks/google-calendar`
- Vapi Custom Tools runtime: `POST /tools/vapi` (aliases: `POST /tools/webhook`, `POST /vapi/tools/webhook`)

## Template API endpoints

- `GET /api/rule-packs`
- `GET /api/templates`
- `POST /api/templates/create-default`
- `POST /api/templates/save`
- `POST /api/templates/:id/activate`
- `DELETE /api/templates/:id`
- `GET /api/templates/:id/compile`
- `GET /api/templates/:id/vapi-draft`
- `POST /api/templates/compile-preview`

## Vapi publish + analytics endpoints

- `POST /api/vapi/create-assistant-from-template`
- `GET /api/vapi/assistants`
- `GET /api/analytics/summary`
- `GET /api/retarget/summary`
- `POST /api/retarget/export`
- `GET /api/dialer/status`
- `POST /api/dialer/reset-stuck`
- `POST /api/dialer/reconcile` (backfills stale `dialing` leads by pulling terminal call status from Vapi `/call/:id`)
- `GET /api/logs/worker` (supports `afterTs`, `limit`, `scope`; used by dashboard 5s polling stream)
- `POST /api/ingest/upload`
- `POST /api/ingest/run`
- `POST /api/booking/test`
- `GET /api/calls` (call activity list with transcript/audio availability flags)
- `GET /api/calls/:leadId`
- `GET /api/calls/:leadId/transcript.txt` (download transcript)
- `GET /api/calls/:leadId/audio` (redirect to recording URL when available)

## Prospector endpoints (5-phase flow)

- `POST /api/prospector/phase1` (gather leads by ICP + market)
- `POST /api/prospector/phase2` (generate + deploy pages)
- `POST /api/prospector/phase3` (organize links + optional GHL sync/tag `jarvis-prospector`)
- `POST /api/prospector/phase4` (build specialized voice script + variables)
- `POST /api/prospector/phase5` (queue specialized Prospector calls with `VAPI_PROSPECTOR_ASSISTANT_ID`)
- `POST /api/prospector/pipeline` (run phases together)
- `GET /api/prospector/leads`
- `GET /api/prospector/runs`
- `GET /api/prospector/records` (DB-backed phase records/logs when `DATABASE_URL` is configured)

## Prospector provider stack

Prospector discovery/enrichment uses a resilient provider chain so one provider failure does not stop lead generation:

- Google Places API (New)
- Google Places API (Legacy) fallback
- Google Custom Search fallback (`GOOGLE_CSE_ID`)
- Firecrawl website scrape enrichment (optional)
- xAI/Gemini lead scoring and opportunity angle generation (optional)

## Vapi tools endpoints

- `GET /api/vapi/tool-catalog`
- `POST /api/vapi/tools/bootstrap` (creates scheduling function tools and can auto-attach to assistant)
- `GET /api/vapi/tools`
- `POST /api/vapi/tools`
- `PATCH /api/vapi/tools/:toolId`
- `DELETE /api/vapi/tools/:toolId`
- `POST /api/vapi/assistants/:assistantId/tool-ids`
- `GET /api/vapi/phone-numbers`
- `GET /api/vapi/phone-numbers/:id`
- `POST /api/vapi/assistants/:assistantId/attach-phone-number`
- `POST /api/vapi/create-additional-agent`

### Tool bootstrap quickstart

Use this once to create and attach the core scheduling tools (`get_event_types`, `get_available_times`, `create_booking`, `sync_ghl_contact`):

```bash
curl -X POST "$BASE_URL/api/vapi/tools/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{
    "assistantId": "your-assistant-id",
    "serverUrl": "https://your-backend.example.com/tools/vapi",
    "strict": true,
    "includeGhlSyncTool": true,
    "attachToAssistant": true,
    "mode": "append"
  }'
```

The runtime endpoint expects the Vapi Custom Tools payload format (`message.toolCallList`) and returns:

```json
{
  "results": [
    { "toolCallId": "tool-call-id", "result": { "ok": true } }
  ]
}
```

## Inbound builder endpoints

- `GET /api/inbound/profile`
- `POST /api/inbound/profile`
- `GET /api/inbound/phases`
- `POST /api/inbound/attach-phone`

## GHL Smart List import endpoint

- `POST /api/ghl/import-smart-list`
  - input: `filterId`, optional `pageLimit`, optional `maxPages`, optional `runIngest`
  - behavior: pulls contacts from GHL, writes CSV into incoming queue, optionally runs ingest immediately

If local, expose server publicly (ngrok/cloudflared) and register public URLs.

## Retarget CSV output

- Latest rolling buckets are written to `data/retarget/latest/`:
- `no-answer.csv`
- `answered-hung-up.csv`
- `voicemail.csv`
- `no-contact.csv`
- `POST /api/retarget/export` can also create timestamped snapshots in `data/retarget/runs/<timestamp>/`.

## Reconcile controls

- `RECONCILE_INTERVAL_SECONDS=60` (default)
- `RECONCILE_MIN_AGE_SECONDS=180` (default)
- The runtime now auto-reconciles stale `dialing` leads against Vapi call status to prevent stuck statuses when webhooks are missed.

## CSV Format

Flexible headers are supported. Common aliases:

- `phone`, `phone_number`, `mobile`
- `first_name`, `firstname`
- `last_name`, `lastname`
- `company`, `business_name`
- `email`
- `timezone`, `time_zone`
- `opt_in`, `consent`, `permission`
- `dnc`, `do_not_call`, `unsubscribed`
- `findings`, `notes`, `audit_summary`

## Guardrails

Use `prompts/outbound-system-prompt.md` in your Vapi assistant system prompt. It includes:

- prompt-injection resistance
- strict domain limits (no off-topic detours)
- 3-minute maximum duration
- concise rebuttal handling
- meeting CTA

## Platform limit notes

- Twilio outbound calling often starts at low CPS and returns 429 (`20429`) if exceeded.
- Defaults are conservative (`TWILIO_CPS=1`).
- Raise CPS only after Twilio confirms account capacity.
# trd-voicesystem
