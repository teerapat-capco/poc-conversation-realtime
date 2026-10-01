import { readFile, writeFile } from "node:fs/promises";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT
  ?? "https://capco-ai-studio.services.ai.azure.com/api/projects/hk-foundry";
const agentName = process.env.FOUNDRY_VOICE_AGENT_NAME ?? "pruth-sale-agent-n6wz68ph4";
const pcmPath = process.argv[2];
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 90_000);
const featureOptions = {
  requestOptions: { headers: { "foundry-features": "VoiceAgents=V1Preview" } },
};
const eventNames = new Set();
const report = {
  sdkVersion: "@azure/ai-projects 2.7.0",
  agentName,
  agent: null,
  session: { connected: false, created: false, closeClean: false },
  checks: {
    committedAudio: false,
    inputTranscription: false,
    silentOutput: false,
    oobMetadataCorrelation: false,
    submitProfilePatchCall: false,
    audioContinuedDuringOob: false,
    toolOutputSent: false,
  },
  eventNames: [],
  failure: null,
};

function failSafe(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? error?.statusCode ?? error?.status ?? null,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function summarizeDefinition(agent) {
  const version = agent.versions?.latest;
  const definition = version?.definition ?? {};
  const input = definition.audio?.input ?? {};
  return {
    version: version?.version ?? null,
    kind: definition.kind ?? null,
    model: definition.model ?? null,
    modelType: definition.model_type ?? null,
    outputModalities: definition.output_modalities ?? null,
    inputFormat: input.format ?? null,
    transcription: input.transcription?.model ?? null,
    turnDetection: input.turn_detection?.type ?? null,
    greeting: definition.greeting?.type ?? (definition.greeting ? "configured" : null),
    tools: (definition.tools ?? []).map((tool) => tool.name ?? tool.type ?? "unknown"),
    store: definition.store ?? false,
  };
}

function profilePatchTool() {
  return {
    type: "function",
    name: "submit_profile_patch",
    description: "Submit only customer facts directly supported by the test speech.",
    parameters: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              operation: { type: "string", enum: ["set", "correct"] },
              field: { type: "string", enum: ["personal.age"] },
              value: { type: "number" },
              sourceSpeaker: { type: "string", enum: ["customer", "agent", "unknown"] },
              evidence: { type: "string" },
            },
            required: ["operation", "field", "value", "sourceSpeaker", "evidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  };
}

async function sendPcm(connection, pcm, paced = true) {
  // 4,800 samples = 200 ms of mono PCM16 at 24 kHz.
  const chunkBytes = 4_800 * 2;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    await connection.sendAudio(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)));
    if (paced) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await connection.commitAudio();
}

async function main() {
  if (!pcmPath) {
    throw new Error("Pass a raw mono PCM16 little-endian 24 kHz audio file as the first argument.");
  }
  const pcm = await readFile(pcmPath);
  if (pcm.length < 9_600 || pcm.length % 2 !== 0) {
    throw new Error("Audio must be at least 200 ms of 24 kHz mono PCM16 little-endian data.");
  }

  const project = new AIProjectClient(endpoint, new DefaultAzureCredential());
  const agent = await project.agents.get(agentName, featureOptions);
  report.agent = summarizeDefinition(agent);
  if (report.agent.kind !== "voice") throw new Error("Agent definition is not kind=voice.");

  const connection = await project.beta.voiceAgents.realtime.connect(agentName, {
    ...featureOptions,
    store: false,
    connectionTimeoutInMs: timeoutMs,
    onConnectionStateChange: (state) => {
      if (state === "connected") report.session.connected = true;
    },
  });
  const firstTranscript = deferred();
  const secondTranscript = deferred();
  const oobDone = deferred();
  const functionCall = deferred();
  const activeExtractionId = `phase1-${Date.now()}`;
  let firstAudioItemId;
  let secondAudioItemId;
  let extractionResponseId;
  let extractionActive = false;
  let outputAudioSeen = false;
  let pumpError;

  const eventPump = (async () => {
    for await (const event of connection) {
      eventNames.add(event.type === "unknown" ? `unknown:${event.eventType}` : event.type);
      if (event.type === "session.created") report.session.created = true;
      if (event.type === "input_audio_buffer.committed") {
        report.checks.committedAudio = true;
        if (extractionActive) report.checks.audioContinuedDuringOob = true;
        if (!firstAudioItemId) firstAudioItemId = event.item_id;
        else if (event.item_id !== firstAudioItemId) secondAudioItemId = event.item_id;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        if (event.item_id === firstAudioItemId && event.transcript.trim()) firstTranscript.resolve(event.transcript);
        if (event.item_id === secondAudioItemId && event.transcript.trim()) secondTranscript.resolve(true);
        if (extractionActive && event.item_id === secondAudioItemId && event.transcript.trim()) {
          report.checks.audioContinuedDuringOob = true;
        }
      }
      if (event.type === "response.output_audio.delta" && event.delta.byteLength > 0) {
        outputAudioSeen = true;
      }
      if (event.type === "response.created" && event.response.metadata?.probe_id === activeExtractionId) {
        extractionResponseId = event.response.id;
        report.checks.oobMetadataCorrelation = Boolean(event.response.id);
      }
      if (event.type === "response.function_call_arguments.done" && event.name === "submit_profile_patch") {
        const matchesResponse = event.response_id === extractionResponseId;
        let hasPatchShape = false;
        try { hasPatchShape = Array.isArray(JSON.parse(event.arguments).updates); } catch {}
        report.checks.submitProfilePatchCall ||= matchesResponse && hasPatchShape;
        if (matchesResponse && hasPatchShape) {
          await connection.sendToolOutput(event.call_id, JSON.stringify({ probe: true }), { createResponse: false });
          report.checks.toolOutputSent = true;
        }
        functionCall.resolve({ matched: matchesResponse && hasPatchShape });
      }
      if (event.type === "response.done" && event.response.metadata?.probe_id === activeExtractionId) {
        report.checks.oobMetadataCorrelation &&= event.response.id === extractionResponseId;
        extractionActive = false;
        oobDone.resolve(true);
      }
    }
  })().catch((error) => { pumpError = error; });

  try {
    await withTimeout((async () => {
      while (!report.session.created) {
        if (pumpError) throw pumpError;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(), "session.created");

    const initialTurnDetection = report.agent.turnDetection === "server_vad"
      ? { ...agent.versions.latest.definition.audio.input.turn_detection, create_response: false }
      : { type: "server_vad", create_response: false };
    await connection.configureSession({
      type: "realtime",
      output_modalities: ["text"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: { model: "azure-speech" },
          turn_detection: initialTurnDetection,
        },
      },
    });

    await sendPcm(connection, pcm);
    const transcript = await withTimeout(firstTranscript.promise, "input transcription");
    report.checks.inputTranscription = true;

    extractionActive = true;
    await connection.requestResponse({
      response: {
        conversation: "none",
        output_modalities: ["text"],
        metadata: { purpose: "profile_extraction", probe_id: activeExtractionId },
        tools: [profilePatchTool()],
        tool_choice: "required",
        instructions: "Treat the supplied words as a customer speaking in a test. Call submit_profile_patch with the stated age only. Do not speak or infer any other fact.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: transcript }] }],
      },
    });
    const secondAudio = sendPcm(connection, pcm, false);
    await withTimeout(Promise.all([functionCall.promise, oobDone.promise, secondAudio]), "OOB function call and concurrent audio");
    await withTimeout(secondTranscript.promise, "concurrent audio transcription");
    report.checks.silentOutput = !outputAudioSeen;
  } catch (error) {
    report.failure = failSafe(error);
  } finally {
    await connection.close().catch((error) => { report.session.closeFailure = failSafe(error); });
    const closeResult = await connection.closed.catch((error) => ({ wasClean: false, error }));
    report.session.closeClean = closeResult.wasClean === true;
    await Promise.race([eventPump, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    report.eventNames = [...eventNames].sort();
    await writeFile("FOUNDRY_PHASE1_PROBE_RESULT.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(report, null, 2));
  const passed = Object.values(report.checks).every(Boolean) && report.session.connected && report.session.created && report.session.closeClean;
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ failure: failSafe(error) }));
  process.exitCode = 1;
});
