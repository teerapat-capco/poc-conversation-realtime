# Foundry Voice Agent migration: Phase 1 and Phase 2

## Goal and current status

Move the customer-profile POC from direct Azure OpenAI Realtime WebRTC to the existing Microsoft Foundry Voice Agent, using Microsoft Entra ID credentials from `az login` during local development. Preserve the POC's one-microphone, live transcript, silent-observer, out-of-band (OOB) extraction, function-call patch, manual-edit priority, and Stop behavior.

This is a migration plan, not an implementation record. `IMPLEMENTATION_PLAN.md` remains the source of the product acceptance scenarios. Its Azure OpenAI `/openai/v1` and browser WebRTC connection instructions apply only to the existing implementation; they cannot be reused unchanged for the Foundry Agent.

Phase 1 was reported passed by the user. Phase 2 code is integrated locally; its live-browser acceptance gate remains unverified until run against the real Agent.

Known configuration:

- Project endpoint: `https://capco-ai-studio.services.ai.azure.com/api/projects/hk-foundry`
- Agent name used by the API: `pruth-sale-agent-n6wz68ph4`
- Configured model reported by the user: `gpt-realtime-2.1-mini`
- The user has already tested the Agent in the Foundry playground and confirmed that the Agent identifier is correct.
- On 2026-10-01, the user's `test-agent.ps1` returned that Agent name from `GET /agents/{agent_name}?api-version=v1` after `az login`. This proves project API authentication and read access for that signed-in account. It does **not** prove an SDK realtime connection or OOB support.

Do not print or commit access tokens. The project endpoint and Agent name are identifiers, not credentials. The local Azure CLI login belongs to the user running the app; a deployed server will need its own identity and role assignment.

## Phase 1: SDK and protocol proof

**Objective:** Prove the existing Agent can satisfy the POC's realtime and OOB requirements before replacing the browser connection. Use a disposable Node.js probe; leave the page and current connection path runnable.

### Work

1. Check the active Azure CLI account/subscription and install only the SDK packages needed by the probe: `@azure/ai-projects` and `@azure/identity`. Use the documented SDK version that supports `voiceAgents.realtime`. Authenticate on the Node.js server side with `DefaultAzureCredential`; never put an Entra access token in browser state or logs.
2. Read the Agent definition and active version with `project.agents.get(agentName, ...)`. Record whether it is a voice Agent, its model, transcription/turn-detection settings, greeting, tools, and storage behavior. Do not create, edit, or delete an Agent version during this phase.
3. Call `project.beta.voiceAgents.realtime.connect(agentName, { store: false })`, consume the event stream, confirm a session-created/connected event, then close cleanly. Record event names and any failure status without recording tokens or raw customer audio. A successful REST GET alone does not satisfy this step.
4. Send a short audio sample or live microphone audio through that SDK session. Confirm that committed speech and input transcription events arrive, and determine the actual audio format and item identifiers. Confirm whether the Agent speaks automatically; the POC needs a silent observer.
5. In the same live session, test the exact extraction requirements: request a text-only OOB response with `conversation: "none"`, correlate it by metadata/response ID, make `submit_profile_patch` available as a function tool, and verify that a real function-call event contains patch arguments. While the response is running, send more audio and confirm its commit/transcription still arrives. Check whether the Agent permits these per-response overrides, whether it speaks, and whether the function call must be acknowledged with a tool output.
6. Check Stop behavior: finish or time out pending audio/extraction, close the SDK connection, and confirm no further audio or events are processed.

### Evidence and exit gate

Record a short probe report with the SDK version, exact command, Agent version, event names, supported/unsupported response fields, and sanitized pass/fail results for connection, transcript, silent mode, OOB, function call, concurrent audio, and cleanup. Keep any customer transcript out of routine logs.

**Phase 1 passes only when** the SDK opens a realtime session and the same session supports silent listening, incoming transcript, a correlated OOB `submit_profile_patch` call, and continued audio/transcription during extraction. If any of those fail, stop before Phase 2 and report the specific protocol limitation. A separate text extraction request could be evaluated later, but it would change the original one-session acceptance condition and is not an automatic fallback.

## Phase 2: Integrate the proven Agent path into the POC

**Prerequisite:** Phase 1 exit gate passed with the Agent and SDK versions that Phase 2 will use.

### Work

1. Add Foundry configuration such as `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_VOICE_AGENT_NAME`; document local `az login` and missing-RBAC errors. Remove the API-key requirement for the selected Foundry path. Retire the existing `/api/realtime/token` flow only after the new path works. Pin the SDK versions proven in Phase 1.
2. Add a small Node.js voice bridge for the POC. The browser sends microphone PCM to the bridge over a local WebSocket; the bridge uses `DefaultAzureCredential` and the SDK to stream to the Agent, then forwards normalized transcript, response, function-call, error, and lifecycle events. Keep the credential and Foundry WebSocket connection server side. Choose the PCM format, chunk size, and buffering from Phase 1 observations. Do not assume the current browser WebRTC offer/data channel can connect to the project endpoint.
3. Keep profile state, manual field ownership, patch validation, and UI updates in the browser. Adapt the event routing and extraction requests in `src/components/profile-workspace.tsx` to the bridge's confirmed event contract. Reuse `src/lib/profile-patch.ts` and the useful scheduling/retry rules in `src/lib/extraction.ts`; change item-reference construction only if Phase 1 proves a different supported form. Preserve at-most-one extraction, roughly 10-second dirty scheduling, customer correction, and manual-edit priority.
4. Update Start/Stop for microphone PCM capture, permission errors, bridge/Agent disconnects, bounded final audio flush and extraction, and cleanup of audio tracks, WebSocket, timers, and SDK connection. Do not return Entra tokens to the browser. Keep the event log bounded and free of tokens and routine full customer data.
5. Add a single documented local start command that launches the Next.js page and the bridge. Constrain the POC bridge to localhost and check the browser origin. If a hosted deployment is later required, use a managed identity with the appropriate Foundry role; `az login` on a developer machine does not authenticate a remote server.

Likely files: `package.json`, `src/lib/config.ts`, `src/app/page.tsx`, `src/components/profile-workspace.tsx`, a new Node bridge and small browser audio transport module, focused tests, and `.env.example`. Do not modify the Agent definition or add a database/backend sync as part of this migration.

### Verification and exit gate

Local launch command: `npm run dev` (starts Next.js on `http://localhost:3000` and the loopback-only Foundry bridge on `127.0.0.1:8787`). Set `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_VOICE_AGENT_NAME` in `.env.local`; install Azure CLI so `az` is on the same `PATH` as VS Code, then run `az login`. The bridge uses `DefaultAzureCredential` and Node's system CA store. If a TLS-inspecting network's root CA is not installed in the system store, set `NODE_EXTRA_CA_CERTS` to its trusted PEM certificate before starting; do not disable TLS verification. A 401 requires a valid Entra login, and a 403 requires the signed-in identity to have the appropriate Foundry project role. Do not use this local CLI login as authentication for a hosted server.

- Run focused tests for event mapping, extraction correlation/retry, patch validation, and manual-edit priority, followed by `npm run typecheck`, `npm run lint`, and `npm run build`.
- Run the browser against the real Agent. Verify Start/listening status, transcript, no spoken interruption, a real `submit_profile_patch` event, profile update, correction, manual ownership, and audio/transcript arriving during OOB work.
- Stop the session and verify microphone, browser socket, server SDK connection, and timers close. Record the exact launch command and any Azure configuration issue.

**Phase 2 passes only when** these live checks satisfy the existing Phase 3 acceptance criteria in `IMPLEMENTATION_PLAN.md`. The two-person Phase 4 proof remains a separate next step.

## References

- [Foundry voice Agent quickstart and JavaScript SDK example](https://learn.microsoft.com/en-us/azure/foundry/agents/quickstarts/prompt-voice-agent)
- [VoiceAgentConnection API](https://learn.microsoft.com/en-us/javascript/api/%40azure/ai-projects/voiceagentconnection)
- [Foundry Agent properties and REST authentication](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-agent)
- [Azure Identity for local Node.js development](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/local-development-environment-developer-account)
