# Implementation plan: Realtime conversation to customer model PoC

## Objective

Prove that one Azure `gpt-realtime-1.5` session can keep receiving audio from one
microphone while out-of-band (OOB) work extracts customer facts and invokes an
application function. Validated facts immediately update a shared model object
shown in the UI. The seller can edit any field; a manual edit takes precedence
over later AI updates for that field during the session.

This plan is for implementation in this directory itself:
`C:\Users\TKRP\Projects\poc-realtime`. Do not create a nested app directory.
`gpt-6-luna` is the proposed coding agent for implementing this plan;
`gpt-realtime-1.5` is the Azure model used by the running PoC.

## Decisions already made

- One microphone captures both the seller and customer. Speaker identity is an
  inference, so a seller's question alone must not become a customer fact.
- No approval or review step. Accepted AI patches update the UI immediately.
- One shared `CustomerProfile` feeds the example KYC, FNA, and Goal sections on
  a single PoC page. Recommend and Proposal may display derived/read-only values
  in the demo, but full forms are outside this PoC.
- A seller's manual edit wins over AI for the remainder of the current session.
- No insurance backend, database, persistence, authentication, or multi-page flow
  in the PoC. The event log is for the demo and should not expose secrets.
- Use the Azure Realtime GA `/openai/v1` protocol and WebRTC in the browser.

## Configuration and prerequisites

The machine has Node.js `26.7.0`, npm `11.19.0`, and PowerShell `7.6.5`.
Next.js requires Node.js `20.9` or newer. Use npm and keep `package.json`,
`node_modules`, `.env.local`, and source files at the project root.

Create `.env.example` with empty values and `.env.local` ignored by Git:

```dotenv
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_REALTIME_DEPLOYMENT=
AZURE_TRANSCRIPTION_DEPLOYMENT=
```

The deployment name is configurable; it must point to `gpt-realtime-1.5` for
this PoC. Live input transcription requires a supported transcription
deployment. Never put the long-lived Azure key in `NEXT_PUBLIC_*` variables.
If values are missing, the UI should explain which configuration is missing
without attempting a live connection.

## Data contract

Start with a small allowlist of fields that demonstrates mapping across forms:

| Field | Example page | Type |
| --- | --- | --- |
| `personal.age` | KYC | integer |
| `personal.heightCm` | KYC | number |
| `personal.occupation` | KYC | string |
| `financial.monthlyIncome` | FNA | nonnegative number |
| `financial.monthlyExpenses` | FNA | nonnegative number |
| `goals.retirement.targetAge` | Goal | integer |
| `goals.retirement.monthlyTarget` | Goal | nonnegative number |

Use one typed `CustomerProfile` object and a `ProfilePatch` containing only
new or corrected fields. Each update carries `field`, `value`, `operation`,
`sourceSpeaker`, and a short `evidence` quote. The application validates the
field and value, applies the patch deterministically, and stores provenance
internally. A repeated value is a no-op. Manual edits mark their fields as
manual-owned until the session ends. Do not treat a numeric confidence score
from the model as proof of speaker identity.

## Phase 1 — Project and single-page shell

1. Initialize a minimal Next.js App Router + TypeScript project in this
   directory. Add only dependencies needed for the PoC, including a schema
   validator.
2. Add configuration loading, `.env.example`, and `.gitignore`.
3. Build one page with Start/Stop, connection/listening status, live transcript,
   editable customer fields grouped as KYC/FNA/Goal, and a bounded event log.
4. Keep the shared profile in one client-side state owner so form edits and AI
   patches use the same update path.

**Done when:** `npm run dev` loads the page; manual edits update the model
display; missing Azure config produces a clear message. Run lint/typecheck and
build. No Azure connection is required to pass this phase.

## Phase 2 — Live listening and transcript

1. Add a Next.js server route that requests an ephemeral Realtime client token
   from Azure using the server-side key.
2. Connect the browser to Azure over WebRTC, send its microphone track, and
   receive Realtime events over the data channel.
3. Configure the session as a silent observer: server VAD commits speech but
   does not create ordinary assistant responses automatically.
4. Enable input audio transcription with the configured transcription
   deployment. Display transcript deltas/completed items in order, showing
   `speaker unknown` unless the application has reliable evidence otherwise.
5. Handle Stop, microphone denial, connection errors, and cleanup of tracks,
   data channel, and peer connection.

**Done when:** the status shows connected/listening, microphone speech appears
in the transcript, and no AI voice response interrupts the conversation.
Verify with the user's Azure configuration; a missing deployment leaves this
phase unverified rather than faking a successful live result.

## Phase 3 — OOB extraction, function call, and live mapping

1. Mark the conversation dirty when new committed speech arrives. Request at
   most one extraction at a time, roughly every 10 seconds while dirty, plus a
   final extraction before Stop closes the connection. Track a conversation version so speech arriving
   during extraction triggers another run.
2. Send `response.create` with `conversation: "none"`, text output, and
   `metadata` containing a purpose and extraction ID. Keep the microphone and
   VAD running throughout.
3. Give the OOB response one function tool, `submit_profile_patch`, whose
   arguments match the `ProfilePatch` schema. Route the resulting function-call
   event by response/extraction ID; do not assume the next `response.done`
   belongs to extraction.
4. Validate tool arguments and business ranges. Ignore agent-only facts,
   unsupported fields, malformed values, and updates to manual-owned fields.
   Apply accepted changes immediately to the shared profile. Support customer
   corrections.
5. Show technical events in the UI log: extraction requested, function called,
   patch accepted/rejected, profile changed, timeout/error. Keep secrets and
   full customer data out of routine server logs.

**Done when:** speech continues during an OOB response, a real
`submit_profile_patch` call appears in the log, and a spoken age/income/goal
updates the bound model. A customer correction changes an earlier AI value;
a later AI extraction does not overwrite a seller's manual edit.

## Phase 4 — Focused proof and handoff

Run a short two-person conversation through one microphone:

1. Customer says age 35, occupation, monthly income 80,000, and retirement
   goal at age 55 with 50,000 per month.
2. Seller asks, “คุณอายุ 40 ใช่ไหม” without customer confirmation: age must
   stay 35.
3. Customer corrects age to 36: age must become 36.
4. Seller manually changes one field; another extraction must not overwrite it.
5. Observe transcript events arriving while an OOB extraction/tool call is
   in progress. Stop the session and confirm cleanup.

Record what was actually verified, any Azure configuration or deployment issue,
and the exact command needed to start the app. Run only focused checks needed
for this proof; do not expand the PoC into backend sync or complete forms.

## Implementation notes for the next coding session

- Implement one phase at a time, preserving a runnable page after each phase.
- Check the exact Azure GA event fields against the configured deployment at
  integration time; examples from preview protocol are not interchangeable.
- Keep Realtime connection code, event routing, extraction scheduling, patch
  validation/reducer, and UI state separate by responsibility without adding
  provider abstraction or infrastructure not used by this PoC.
- If the Azure deployment cannot produce live input transcription, report the
  limitation and required deployment instead of claiming the transcript works.
- The proof is the overlap of incoming audio/transcript with OOB work and an
  actual application function call, not merely a final summary after Stop.

## References

- [Next.js installation and Node.js requirement](https://nextjs.org/docs/app/getting-started/installation)
- [Azure Realtime via WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc)
- [Azure session configuration and OOB responses](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio)
- [Azure Realtime GA event reference](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga)
