# Azure GPT Realtime - Out-of-Band Customer Profile Extraction

> Implementation design for a Next.js application that listens to an
> insurance sales conversation and gradually builds a structured
> customer profile without interrupting the conversation.

## 1. Goal

We want the application to listen to a live conversation between an
**insurance agent** and a **customer**.

While the conversation continues, the system should periodically ask GPT
Realtime to analyze what it has heard so far and extract useful customer
information, for example:

-   age
-   height / weight
-   occupation
-   income
-   expenses
-   debt
-   savings
-   financial goals
-   retirement goal
-   protection goal
-   other fields required by the insurance flow

The extraction must **not interrupt the live conversation**.

The extracted data is kept as structured application state and later
sent to the backend based on a trigger or schedule.

------------------------------------------------------------------------

## 2. Main idea

Use one GPT Realtime session for the live conversation.

During the session, send an **Out-of-Band (OOB) response** when we want
GPT to analyze the conversation.

An OOB response is created with:

``` json
{
  "type": "response.create",
  "response": {
    "conversation": "none"
  }
}
```

`conversation: "none"` is important. It tells Realtime that this
response is outside the normal conversation. The result therefore does
not need to become another normal conversation turn.

Microsoft also recommends using `metadata` to identify which generated
response belongs to which client request.

Reference:

-   Microsoft Learn - Realtime audio:
    https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio
-   Microsoft Learn - Realtime audio events:
    https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga
-   Microsoft Learn - Realtime WebSocket architecture:
    https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets

------------------------------------------------------------------------

## 3. High-level architecture

``` text
Insurance Agent + Customer
            |
            | audio
            v
+---------------------------+
| Azure GPT Realtime        |
|                           |
| Live Realtime Session     |
| keeps listening           |
+-------------+-------------+
              |
              | conversation continues
              |
       extraction trigger
              |
              v
+---------------------------+
| OOB response.create       |
|                           |
| conversation: "none"      |
| output: text              |
| purpose: profile_extract  |
+-------------+-------------+
              |
              | JSON
              v
+---------------------------+
| Profile Patch Validator   |
|                           |
| Validate JSON/schema      |
+-------------+-------------+
              |
              v
+---------------------------+
| Profile Reducer / Mapper  |
|                           |
| Merge only changed data   |
+-------------+-------------+
              |
              v
+---------------------------+
| Customer Profile State    |
+-------------+-------------+
              |
      backend sync trigger
              |
              v
+---------------------------+
| Next.js Backend / BFF     |
+-------------+-------------+
              |
              v
+---------------------------+
| Insurance Backend         |
+---------------------------+
```

There are therefore **two separate loops**:

1.  **Listening loop** - audio continues to enter the Realtime session.
2.  **Extraction loop** - from time to time we ask the same session to
    analyze information and return structured data.

The extraction loop should not stop the listening loop.

------------------------------------------------------------------------

# 4. Important design rule: return a Patch, not the whole Profile

Avoid asking GPT to regenerate the complete customer profile every few
seconds.

Bad pattern:

``` json
{
  "age": 35,
  "heightCm": null,
  "monthlyIncome": 80000,
  "monthlyExpense": null,
  "goal": "retirement",
  "retirementAge": 55
}
```

If this is generated repeatedly, the model has to repeat old information
and the application has to decide whether every field is old, new,
missing, or accidentally changed.

Instead, ask GPT for **only newly discovered or corrected information**.

Example 1:

Customer says:

``` text
ผมอายุ 35 ครับ
```

OOB result:

``` json
{
  "updates": [
    {
      "operation": "set",
      "field": "personal.age",
      "value": 35,
      "sourceSpeaker": "customer",
      "evidence": "ผมอายุ 35 ครับ"
    }
  ]
}
```

Later:

``` text
รายได้ประมาณ 80,000 ต่อเดือนครับ
```

OOB result:

``` json
{
  "updates": [
    {
      "operation": "set",
      "field": "financial.monthlyIncome",
      "value": 80000,
      "sourceSpeaker": "customer",
      "evidence": "รายได้ประมาณ 80,000 ต่อเดือนครับ"
    }
  ]
}
```

The application merges those patches.

Result:

``` json
{
  "personal": {
    "age": 35
  },
  "financial": {
    "monthlyIncome": 80000
  }
}
```

This makes GPT responsible for **understanding the conversation**, while
normal TypeScript code remains responsible for **owning application
state**.

------------------------------------------------------------------------

# 5. Data model

A simple first version can look like this:

``` ts
export interface CustomerProfile {
  personal: {
    age?: number;
    heightCm?: number;
    weightKg?: number;
    occupation?: string;
  };

  financial: {
    monthlyIncome?: number;
    monthlyExpenses?: number;
    debt?: number;
    savings?: number;
  };

  goals: FinancialGoal[];

  meta: {
    sessionId: string;
    version: number;
    lastUpdatedAt: string;
  };
}

export interface FinancialGoal {
  id: string;
  type: string;

  targetAge?: number;
  targetAmount?: number;
  monthlyTarget?: number;

  description?: string;
}
```

For a production system, keep evidence for important fields.

``` ts
export interface ExtractedValue<T> {
  value: T;

  source: {
    speaker: "customer" | "agent" | "unknown";
    evidence: string;
    conversationItemId?: string;
  };

  extractedAt: string;
}
```

Then age can become:

``` json
{
  "value": 35,
  "source": {
    "speaker": "customer",
    "evidence": "ผมอายุ 35 ครับ"
  },
  "extractedAt": "2026-10-01T10:00:00Z"
}
```

This is useful when a value needs to be reviewed later.

------------------------------------------------------------------------

# 6. ProfilePatch model

Recommended patch structure:

``` ts
export type ProfileField =
  | "personal.age"
  | "personal.heightCm"
  | "personal.weightKg"
  | "personal.occupation"
  | "financial.monthlyIncome"
  | "financial.monthlyExpenses"
  | "financial.debt"
  | "financial.savings";

export interface ProfileUpdate {
  operation: "set" | "correct";

  field: ProfileField;

  value: string | number | boolean | null;

  sourceSpeaker: "customer" | "agent" | "unknown";

  evidence?: string;
}

export interface ProfilePatch {
  updates: ProfileUpdate[];

  goals?: Array<{
    operation: "add" | "update";
    type: string;
    targetAge?: number;
    targetAmount?: number;
    monthlyTarget?: number;
    description?: string;
    evidence?: string;
  }>;
}
```

An empty extraction is valid:

``` json
{
  "updates": [],
  "goals": []
}
```

Do **not** force the model to invent a value just because a field exists
in the schema.

------------------------------------------------------------------------

# 7. Realtime session behavior

The Realtime session is primarily a **listener / observer**.

Conceptually:

``` text
Agent --------\
               \
                >---- audio ----> GPT Realtime
               /
Customer -----/

                         |
                         | listening
                         |
                         +---- OOB extraction
                         |
                         +---- OOB extraction
                         |
                         +---- OOB extraction
```

The application should avoid making the assistant speak unless speaking
is part of the product requirement.

If VAD is used, configure the session so the end of every speech turn
does not automatically cause an assistant answer when the product is
intended to be a silent observer.

------------------------------------------------------------------------

# 8. OOB extraction request

Example helper:

``` ts
function requestProfileExtraction(
  dataChannel: RTCDataChannel,
  extractionId: string
) {
  dataChannel.send(
    JSON.stringify({
      type: "response.create",

      response: {
        conversation: "none",

        metadata: {
          purpose: "customer_profile_extraction",
          extractionId
        },

        output_modalities: ["text"],

        instructions: `
You are observing a conversation between an insurance agent
and a customer.

Analyze the conversation information available to you.

Find only NEW or CORRECTED customer information that should
update the customer profile.

Important rules:

1. Do not guess missing information.
2. Do not treat information about the insurance agent as
   customer information.
3. A question from the agent is not a confirmed customer fact.
4. Prefer information directly stated or confirmed by the customer.
5. If the customer corrects an earlier value, use operation "correct".
6. Return JSON only.
7. If nothing useful changed, return empty arrays.

Return this shape:

{
  "updates": [
    {
      "operation": "set | correct",
      "field": "personal.age",
      "value": 35,
      "sourceSpeaker": "customer",
      "evidence": "..."
    }
  ],
  "goals": []
}
        `
      }
    })
  );
}
```

**Note:** The exact Realtime request fields should be checked against
the Azure API version/deployment used by the project. Microsoft
documentation currently shows OOB responses using `response.create`,
`conversation: "none"`, optional custom `input`, and `metadata`.

------------------------------------------------------------------------

# 9. Why metadata matters

OOB responses may happen while other Realtime events are also arriving.

Therefore do not assume:

``` text
the next response.done = my profile extraction
```

Use metadata.

Request:

``` json
{
  "metadata": {
    "purpose": "customer_profile_extraction",
    "extractionId": "extract_123"
  }
}
```

When a response completes:

``` ts
function handleResponseDone(event: any) {
  const metadata = event.response?.metadata;

  if (metadata?.purpose !== "customer_profile_extraction") {
    return;
  }

  const extractionId = metadata.extractionId;

  // Continue processing the extraction result.
}
```

This becomes even more important if later the same session also uses OOB
responses for:

-   customer profile extraction
-   compliance checks
-   sales hints
-   conversation summary
-   next-best action

Example:

``` text
Realtime Session
      |
      +---- OOB: customer_profile
      |
      +---- OOB: compliance_check
      |
      +---- OOB: conversation_summary
```

`metadata.purpose` tells the application which pipeline owns each
result.

Microsoft explicitly recommends checking response metadata when handling
OOB responses.

------------------------------------------------------------------------

# 10. Extraction trigger design

Do not extract on every audio packet or every transcript delta.

That would produce too many requests.

Recommended strategy:

``` text
conversation activity
        |
        v
mark conversationDirty = true
        |
        v
wait for trigger
        |
        +---- debounce timer
        |
        +---- periodic fallback
        |
        +---- important application event
        |
        +---- conversation end
        |
        v
run extraction
```

Suggested first PoC settings:

``` ts
const EXTRACTION_DEBOUNCE_MS = 5_000;
const EXTRACTION_MAX_WAIT_MS = 15_000;
```

These values are starting points, not hard requirements.

------------------------------------------------------------------------

# 11. Extraction state machine

Keep extraction state explicit.

``` ts
interface ExtractionState {
  dirty: boolean;
  running: boolean;

  lastRequestedAt?: number;
  lastCompletedAt?: number;

  pendingExtractionId?: string;
}
```

Flow:

``` text
                conversation changed
                         |
                         v
                    dirty=true
                         |
                         v
                  wait for trigger
                         |
                         v
                  running already?
                   /          \
                 yes           no
                  |             |
               wait             v
                         running=true
                               |
                               v
                       response.create
                               |
                               v
                         OOB processing
                               |
                               v
                         response.done
                               |
                               v
                       validate JSON
                               |
                               v
                        apply patches
                               |
                               v
                       running=false
```

------------------------------------------------------------------------

# 12. Important race condition

Imagine extraction starts at T=10.

While GPT is generating the extraction, the customer continues talking.

``` text
T=10     extraction starts
             |
T=11     customer says new information
             |
T=12     extraction finishes
```

Do **not** blindly set:

``` ts
dirty = false;
```

because new conversation activity happened while extraction was running.

Use a version counter.

``` ts
let conversationVersion = 0;

function onConversationChanged() {
  conversationVersion += 1;
}
```

When extraction starts:

``` ts
const extractionVersion = conversationVersion;
```

When it finishes:

``` ts
if (conversationVersion === extractionVersion) {
  state.dirty = false;
} else {
  state.dirty = true;
}
```

Now the system knows another extraction is required.

------------------------------------------------------------------------

# 13. Recommended extraction scheduler

Pseudo-code:

``` ts
class ExtractionScheduler {
  private dirty = false;
  private running = false;

  private conversationVersion = 0;

  markConversationChanged() {
    this.dirty = true;
    this.conversationVersion += 1;

    this.scheduleDebouncedExtraction();
  }

  async extractIfNeeded() {
    if (!this.dirty) return;
    if (this.running) return;

    this.running = true;

    const versionAtStart = this.conversationVersion;

    try {
      await requestOobExtraction();

      if (this.conversationVersion === versionAtStart) {
        this.dirty = false;
      }
    } finally {
      this.running = false;

      if (this.dirty) {
        this.scheduleDebouncedExtraction();
      }
    }
  }
}
```

------------------------------------------------------------------------

# 14. Processing the result

The processing pipeline should be:

``` text
OOB text
   |
   v
JSON.parse
   |
   v
Schema validation
   |
   v
Business validation
   |
   v
Profile reducer
   |
   v
CustomerProfile
```

Never directly trust generated JSON.

Example using Zod:

``` ts
import { z } from "zod";

const ProfileUpdateSchema = z.object({
  operation: z.enum(["set", "correct"]),

  field: z.enum([
    "personal.age",
    "personal.heightCm",
    "personal.weightKg",
    "personal.occupation",
    "financial.monthlyIncome",
    "financial.monthlyExpenses",
    "financial.debt",
    "financial.savings"
  ]),

  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null()
  ]),

  sourceSpeaker: z.enum([
    "customer",
    "agent",
    "unknown"
  ]),

  evidence: z.string().optional()
});

const ProfilePatchSchema = z.object({
  updates: z.array(ProfileUpdateSchema),
  goals: z.array(z.any()).default([])
});
```

Then:

``` ts
function parseProfilePatch(raw: string): ProfilePatch | null {
  try {
    const json = JSON.parse(raw);

    const result = ProfilePatchSchema.safeParse(json);

    if (!result.success) {
      console.error(result.error);
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
}
```

------------------------------------------------------------------------

# 15. Business validation

Schema validation only answers:

> Is this JSON structurally correct?

It does not answer:

> Does this value make sense for our business?

Add another validation layer.

Example:

``` ts
function validateBusinessRule(
  update: ProfileUpdate
): boolean {
  switch (update.field) {
    case "personal.age":
      return (
        typeof update.value === "number" &&
        update.value >= 0 &&
        update.value <= 120
      );

    case "personal.heightCm":
      return (
        typeof update.value === "number" &&
        update.value >= 50 &&
        update.value <= 250
      );

    case "financial.monthlyIncome":
      return (
        typeof update.value === "number" &&
        update.value >= 0
      );

    default:
      return true;
  }
}
```

Exact ranges must follow the actual insurance business rules.

------------------------------------------------------------------------

# 16. Profile reducer

GPT should not mutate the application object directly.

Use normal deterministic code.

``` ts
function applyProfilePatch(
  profile: CustomerProfile,
  patch: ProfilePatch
): CustomerProfile {
  const next = structuredClone(profile);

  for (const update of patch.updates) {
    if (update.sourceSpeaker !== "customer") {
      continue;
    }

    if (!validateBusinessRule(update)) {
      continue;
    }

    setByPath(next, update.field, update.value);
  }

  next.meta.version += 1;
  next.meta.lastUpdatedAt = new Date().toISOString();

  return next;
}
```

Concept:

``` text
GPT
 |
 | suggests changes
 v
ProfilePatch
 |
 v
Validator
 |
 v
Reducer
 |
 | deterministic code
 v
CustomerProfile
```

The LLM understands language.

The application owns state.

------------------------------------------------------------------------

# 17. Corrections

Corrections are very important in a live conversation.

Example:

``` text
Customer:
"ผมอายุ 35 ครับ"

... later ...

Customer:
"ขอโทษครับ เมื่อกี้บอกผิด ผม 36"
```

Expected patch:

``` json
{
  "updates": [
    {
      "operation": "correct",
      "field": "personal.age",
      "value": 36,
      "sourceSpeaker": "customer",
      "evidence": "ขอโทษครับ เมื่อกี้บอกผิด ผม 36"
    }
  ],
  "goals": []
}
```

The reducer replaces 35 with 36.

For important fields, keeping old values in an audit log is recommended.

``` ts
interface ProfileAuditEvent {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  operation: "set" | "correct";
  evidence?: string;
  timestamp: string;
}
```

------------------------------------------------------------------------

# 18. Agent question is not customer data

This case must be handled carefully.

Conversation:

``` text
Agent:
"คุณอายุ 35 ใช่ไหมครับ?"
```

Do not immediately save:

``` json
{
  "age": 35
}
```

because this is information stated by the agent.

If the customer answers:

``` text
Customer:
"ใช่ครับ"
```

the model may use conversation context to understand that the customer
confirmed age 35.

The extraction prompt should therefore clearly say:

``` text
A value mentioned only in an agent question is not a confirmed
customer fact.

It can become confirmed if the customer clearly confirms it.
```

------------------------------------------------------------------------

# 19. Backend sync is a separate problem

Do not make every OOB extraction call the insurance backend.

Keep two pipelines separate:

``` text
Conversation
     |
     v
OOB Extraction
     |
     v
Profile Patch
     |
     v
Local Profile
     |
     v
Sync Scheduler
     |
     v
Backend
```

This allows extraction to happen frequently without creating excessive
backend requests.

------------------------------------------------------------------------

# 20. Backend sync triggers

Recommended hybrid strategy:

### Trigger A - debounce

After profile changes, wait a short period.

Example:

``` text
T=0 age changes
    -> schedule sync +5 sec

T=2 income changes
    -> reset sync timer

T=4 goal changes
    -> reset sync timer

T=9 no more changes
    -> sync backend once
```

### Trigger B - important field

Some fields may need faster persistence.

Example:

``` ts
const IMPORTANT_FIELDS = [
  "personal.age",
  "financial.monthlyIncome"
];
```

Whether this is required depends on the real business process.

### Trigger C - periodic fallback

For example:

``` text
if profile is dirty
and last sync > 30 seconds
then sync
```

### Trigger D - conversation end

Always try to flush unsaved changes when the session ends.

### Trigger E - user action

For example:

``` text
Agent clicks "Next"
Agent opens recommendation page
Agent clicks "Calculate"
```

Run a final extraction and/or backend sync before continuing.

------------------------------------------------------------------------

# 21. Backend API design

Prefer PATCH semantics.

Example:

``` http
PATCH /api/sales-sessions/{sessionId}/customer-profile
```

Body:

``` json
{
  "version": 7,
  "changes": {
    "personal": {
      "age": 35
    },
    "financial": {
      "monthlyIncome": 80000
    }
  }
}
```

Or send operations:

``` json
{
  "sessionId": "session_123",
  "profileVersion": 7,
  "operations": [
    {
      "operation": "set",
      "field": "personal.age",
      "value": 35
    },
    {
      "operation": "set",
      "field": "financial.monthlyIncome",
      "value": 80000
    }
  ]
}
```

The operation style works well when auditability is important.

------------------------------------------------------------------------

# 22. Suggested Next.js project structure

``` text
src/
|
+-- app/
|   |
|   +-- api/
|       |
|       +-- realtime/
|       |   +-- session/
|       |       +-- route.ts
|       |
|       +-- sales-sessions/
|           +-- [sessionId]/
|               +-- profile/
|                   +-- route.ts
|
+-- features/
|   +-- realtime/
|       |
|       +-- realtime-client.ts
|       +-- realtime-events.ts
|       +-- extraction-scheduler.ts
|       +-- profile-extractor.ts
|       +-- profile-reducer.ts
|       +-- profile-schema.ts
|       +-- profile-sync.ts
|       +-- types.ts
|
+-- hooks/
|   +-- useRealtimeObserver.ts
|
+-- components/
    +-- ConversationObserver.tsx
    +-- CustomerProfilePanel.tsx
```

Responsibilities:

``` text
realtime-client.ts
    connection + send/receive Realtime events

realtime-events.ts
    event routing

extraction-scheduler.ts
    decide when OOB extraction runs

profile-extractor.ts
    build response.create and collect result

profile-schema.ts
    Zod schema

profile-reducer.ts
    apply valid patch to local state

profile-sync.ts
    debounce + send changes to backend

useRealtimeObserver.ts
    React integration
```

------------------------------------------------------------------------

# 23. Event router

Do not put every event into one large `onmessage`.

Prefer:

``` ts
function handleRealtimeEvent(event: RealtimeEvent) {
  switch (event.type) {
    case "conversation.item.created":
      handleConversationItemCreated(event);
      break;

    case "response.created":
      handleResponseCreated(event);
      break;

    case "response.done":
      handleResponseDone(event);
      break;

    case "error":
      handleRealtimeError(event);
      break;
  }
}
```

Then route OOB results by metadata.

``` ts
function handleResponseDone(event: ResponseDoneEvent) {
  const purpose = event.response?.metadata?.purpose;

  switch (purpose) {
    case "customer_profile_extraction":
      handleProfileExtraction(event);
      break;

    case "compliance_check":
      handleComplianceCheck(event);
      break;

    default:
      handleNormalResponse(event);
  }
}
```

------------------------------------------------------------------------

# 24. Full runtime flow

``` text
[1] Agent starts session
          |
          v
[2] Next.js obtains Realtime session/auth
          |
          v
[3] Browser connects to Azure GPT Realtime
          |
          v
[4] Audio starts
          |
          v
[5] GPT Realtime keeps conversation context
          |
          v
[6] Conversation activity detected
          |
          v
    conversationVersion++
    dirty = true
          |
          v
[7] Extraction scheduler waits
          |
          |  debounce / max wait
          v
[8] response.create
    conversation = none
    metadata.purpose =
      customer_profile_extraction
          |
          +------------------------------+
          |                              |
          | OOB processing               | audio keeps coming
          |                              |
          v                              v
[9] JSON result                  conversation continues
          |
          v
[10] JSON parse
          |
          v
[11] Zod validation
          |
          v
[12] Business validation
          |
          v
[13] Apply ProfilePatch
          |
          v
[14] CustomerProfile updated
          |
          v
[15] mark profileDirty
          |
          v
[16] backend sync scheduler
          |
          v
[17] PATCH insurance backend
```

------------------------------------------------------------------------

# 25. OOB request lifecycle

Use an ID for every extraction.

``` ts
const extractionId = crypto.randomUUID();
```

Store pending request:

``` ts
pendingExtractions.set(extractionId, {
  startedAt: Date.now(),
  conversationVersion
});
```

Request:

``` json
{
  "type": "response.create",
  "response": {
    "conversation": "none",
    "metadata": {
      "purpose": "customer_profile_extraction",
      "extractionId": "..."
    }
  }
}
```

Response:

``` text
response.created
      |
      v
text/content events
      |
      v
response.done
      |
      v
metadata.extractionId
      |
      v
find pending extraction
```

This makes concurrent Realtime events much easier to manage.

------------------------------------------------------------------------

# 26. Avoid overlapping extraction

For the first version, allow only one profile extraction at a time.

``` ts
if (extractionState.running) {
  return;
}
```

If the conversation changes while extraction is running:

``` text
do not start another extraction immediately

instead:

dirty = true

when current extraction finishes
    |
    v
schedule next extraction
```

This keeps behavior predictable.

Microsoft's Realtime documentation supports multiple OOB responses, but
the application does not need to use that concurrency for the same
extraction job.

------------------------------------------------------------------------

# 27. Optional custom context

Azure Realtime OOB responses can also use custom `input`, including
references to existing conversation items.

That becomes useful if the conversation is long.

Instead of asking GPT to consider everything, the application can
eventually send only relevant recent conversation items.

Concept:

``` text
Conversation item 1
Conversation item 2
Conversation item 3
...
Conversation item 80
Conversation item 81
Conversation item 82

Extraction request:
    use item 70 - 82
    + current known profile
```

Example concept:

``` json
{
  "type": "response.create",
  "response": {
    "conversation": "none",

    "metadata": {
      "purpose": "customer_profile_extraction"
    },

    "input": [
      {
        "type": "item_reference",
        "id": "item_80"
      },
      {
        "type": "message",
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": "Extract new customer profile changes."
          }
        ]
      }
    ]
  }
}
```

This can be an optimization after the basic flow works.

------------------------------------------------------------------------

# 28. Error handling

## Invalid JSON

``` text
OOB response
   |
   v
JSON.parse fails
   |
   v
log error
   |
   v
do NOT update profile
   |
   v
keep dirty=true
   |
   v
retry on next extraction cycle
```

Do not crash the Realtime session because one extraction failed.

## Schema validation fails

Same behavior:

``` text
reject patch
log validation problem
continue listening
retry later
```

## OOB response timeout

Example:

``` ts
const EXTRACTION_TIMEOUT_MS = 15_000;
```

If timeout occurs:

``` text
mark extraction failed
running = false
dirty = true
schedule retry
```

Do not immediately retry in a tight loop.

## Backend fails

Keep profile state locally and mark:

``` ts
profileSyncState = "pending";
```

Retry separately.

Realtime extraction should continue even when the backend is temporarily
unavailable.

------------------------------------------------------------------------

# 29. Reconnect

Realtime connection failure and backend failure are separate.

Possible state:

``` ts
type RealtimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

type SyncStatus =
  | "clean"
  | "pending"
  | "syncing"
  | "failed";
```

UI can therefore show:

``` text
Realtime: Connected
Profile:   6 fields captured
Backend:   Pending sync
```

instead of treating everything as one status.

------------------------------------------------------------------------

# 30. Security and privacy

This use case processes personal and financial information.

At minimum:

-   Keep Azure credentials on the server side.
-   Do not log full audio or transcript by default.
-   Do not log extracted financial information in normal application
    logs.
-   Decide how long transcript/evidence should be retained.
-   Use access control for customer profile APIs.
-   Encrypt data in transit.
-   Follow the organization's data retention and consent requirements.
-   Define which fields are allowed to be extracted.
-   Do not let the model create arbitrary profile field names.
-   Keep an audit trail for important updates when required.

Exact controls depend on the organization's security, privacy,
compliance, and insurance requirements.

------------------------------------------------------------------------

# 31. Observability

Log technical events without unnecessarily logging customer content.

Useful metrics:

``` text
realtime.session.duration
realtime.connection.error

extraction.request.count
extraction.success.count
extraction.failure.count
extraction.duration_ms

profile.patch.count
profile.patch.rejected.count

backend.sync.count
backend.sync.failure.count
backend.sync.duration_ms
```

Useful debug metadata:

``` json
{
  "sessionId": "...",
  "extractionId": "...",
  "conversationVersion": 17,
  "profileVersion": 5,
  "durationMs": 842,
  "updateCount": 2
}
```

Avoid putting raw financial information into telemetry unless explicitly
required and approved.

------------------------------------------------------------------------

# 32. Suggested PoC scope

Do not implement everything at once.

## PoC 1 - prove OOB works

Goal:

``` text
audio
  ->
GPT Realtime
  ->
every ~10 seconds
  ->
OOB response.create
  ->
console.log(JSON)
```

Fields:

``` text
age
heightCm
monthlyIncome
goal
```

Success criteria:

-   conversation continues while extraction runs
-   OOB result is received
-   result is JSON
-   metadata identifies the extraction response

## PoC 2 - local profile

Add:

``` text
Zod validation
ProfilePatch
Profile reducer
CustomerProfile panel
```

Success criteria:

``` text
Customer says age
   ->
UI updates age

Customer says income
   ->
UI updates income

Customer corrects age
   ->
UI replaces age
```

## PoC 3 - backend sync

Add:

``` text
debounce
PATCH backend
retry
conversation-end flush
```

## PoC 4 - hard cases

Test:

-   agent asks a leading question
-   customer says "yes"
-   customer corrects a value
-   customer gives approximate values
-   agent and customer interrupt each other
-   long conversation
-   OOB request fails
-   backend fails
-   Realtime reconnects

------------------------------------------------------------------------

# 33. Example test conversation

``` text
Agent:
ตอนนี้คุณลูกค้าอายุเท่าไรครับ

Customer:
35 ครับ

Agent:
ทำงานอะไรอยู่ครับ

Customer:
เป็น software engineer ครับ

Agent:
รายได้ต่อเดือนประมาณเท่าไรครับ

Customer:
ประมาณ 80,000 ครับ

Agent:
มีเป้าหมายทางการเงินอะไรเป็นพิเศษไหมครับ

Customer:
อยากเกษียณตอน 55 แล้วอยากมีเงินใช้ประมาณ
50,000 ต่อเดือน

Agent:
ตอนนี้อายุ 35 ใช่ไหมครับ

Customer:
อ้อ ขอโทษครับ เมื่อกี้พูดผิด ผม 36
```

Expected final profile:

``` json
{
  "personal": {
    "age": 36,
    "occupation": "software engineer"
  },
  "financial": {
    "monthlyIncome": 80000
  },
  "goals": [
    {
      "type": "retirement",
      "targetAge": 55,
      "monthlyTarget": 50000
    }
  ]
}
```

The age should first become 35 and later be corrected to 36.

------------------------------------------------------------------------

# 34. Main implementation rules

Keep these rules visible during development:

1.  **Realtime session keeps listening.**
2.  **OOB is used for analysis, not as a normal conversation turn.**
3.  **Use `conversation: "none"`.**
4.  **Always tag OOB requests with `metadata`.**
5.  **Do not extract on every audio/transcript delta.**
6.  **Return small ProfilePatch updates, not the entire profile every
    time.**
7.  **GPT suggests changes; TypeScript owns the actual state.**
8.  **Validate every generated result before applying it.**
9.  **Agent questions are not automatically customer facts.**
10. **Support customer corrections.**
11. **Extraction scheduling and backend syncing are separate.**
12. **Always flush important pending data when the conversation ends.**
13. **Do not let one failed extraction stop the Realtime session.**
14. **Do not log sensitive customer data unnecessarily.**

------------------------------------------------------------------------

# 35. Recommended first implementation

Start with this exact flow:

``` text
Browser
  |
  | audio
  v
Azure GPT Realtime
  |
  | conversation continues
  |
  +---- every 10 sec IF dirty
           |
           v
      OOB response.create
      conversation: none
           |
           v
       JSON text
           |
           v
      Zod validation
           |
           v
       ProfilePatch
           |
           v
      Profile reducer
           |
           v
      CustomerProfile
           |
           | debounce 5 sec
           v
       Next.js API
           |
           v
     Insurance Backend
```

Once this works reliably, optimize the trigger logic and context window.

------------------------------------------------------------------------

# 36. Implementation checklist

## Azure / Realtime

-   [ ] GPT Realtime deployment is available.
-   [ ] Realtime connection works.
-   [ ] Audio reaches the session.
-   [ ] Session is configured as a silent observer if no spoken AI
    response is needed.
-   [ ] `response.create` works.
-   [ ] OOB request uses `conversation: "none"`.
-   [ ] OOB request includes `metadata`.
-   [ ] `response.done` can be mapped back to its extraction request.

## Extraction

-   [ ] Define allowed profile fields.
-   [ ] Define ProfilePatch.
-   [ ] Write extraction instructions.
-   [ ] Handle empty updates.
-   [ ] Handle corrections.
-   [ ] Handle customer confirmation.
-   [ ] Reject agent-only facts.
-   [ ] Validate JSON.
-   [ ] Validate business rules.

## State

-   [ ] CustomerProfile is owned by application code.
-   [ ] Profile reducer is deterministic.
-   [ ] conversationVersion exists.
-   [ ] profileVersion exists.
-   [ ] Evidence strategy is decided.

## Scheduler

-   [ ] dirty flag exists.
-   [ ] Only one profile extraction runs at a time.
-   [ ] debounce exists.
-   [ ] max-wait fallback exists.
-   [ ] changes during extraction trigger another cycle.
-   [ ] extraction timeout exists.

## Backend

-   [ ] Profile sync API exists.
-   [ ] Sync is debounced.
-   [ ] Failed sync can retry.
-   [ ] End-session flush exists.
-   [ ] API supports version/idempotency strategy.

## Security

-   [ ] Azure long-lived credential is not exposed to browser.
-   [ ] Sensitive fields are not written to normal logs.
-   [ ] Data retention is defined.
-   [ ] Access control is defined.
-   [ ] Audit requirements are defined.

------------------------------------------------------------------------

# 37. Final mental model

Do not think of this system as:

``` text
audio -> GPT -> final summary
```

Think of it as:

``` text
                    LIVE CONVERSATION
                           |
                           v
                    GPT Realtime Session
                           |
             +-------------+-------------+
             |                           |
             | keep listening            | analyze sometimes
             |                           |
             |                           v
             |                    OOB Extraction
             |                           |
             |                           v
             |                     ProfilePatch
             |                           |
             |                           v
             |                    CustomerProfile
             |                           |
             |                           v
             |                    Backend Sync
             |
             +---- conversation continues ---->
```

The Realtime session is the **live listener**.

OOB responses are **temporary analysis jobs**.

`ProfilePatch` is the **bridge between AI and application code**.

`CustomerProfile` is the **application-owned state**.

The backend remains the **persistent source of truth**.

------------------------------------------------------------------------

## References

1.  Microsoft Learn, **Use the GPT Realtime API for speech and audio
    with Azure OpenAI**\
    https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio

2.  Microsoft Learn, **Audio events reference GA**\
    https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga

3.  Microsoft Learn, **Use the GPT Realtime API via WebSockets**\
    https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets

These references document the Realtime event model, `response.create`,
Out-of-Band responses using `conversation: "none"`, response metadata,
custom OOB context, and asynchronous event handling.
