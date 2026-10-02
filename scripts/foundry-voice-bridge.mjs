import { createServer } from "node:http";
import { createRequire } from "node:module";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { WebSocket, WebSocketServer } from "ws";
import { normalizeFoundryVoiceEvent } from "../src/lib/voice-protocol.ts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const HOST = "127.0.0.1";
const PORT = 8787;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);
const FEATURE_OPTIONS = {
  requestOptions: { headers: { "foundry-features": "VoiceAgents=V1Preview" } },
};
const PCM_BYTES_PER_SAMPLE = 2;

function safeErrorCode(error) {
  if (
    error?.name === "AggregateAuthenticationError" &&
    Array.isArray(error.errors) &&
    error.errors.length > 0 &&
    error.errors.every((entry) => entry?.name === "CredentialUnavailableError")
  ) {
    return "credential_unavailable";
  }
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const candidate = current.code ?? current.statusCode ?? current.status;
    if (typeof candidate === "string" || typeof candidate === "number") {
      return String(candidate).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
    }
    current = current.cause;
  }
  return "unknown";
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendFailure(socket, error, fallback = "Foundry voice session could not start.", stage = "connection") {
  const code = safeErrorCode(error);
  const status = Number(code);
  const message = /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_AUTHORITY_INVALID/.test(code)
    ? "Node.js could not trust the TLS certificate. The bridge uses the system CA store; if your network inspects TLS, trust its root CA or set NODE_EXTRA_CA_CERTS before starting."
    : code === "credential_unavailable"
      ? "DefaultAzureCredential found no usable local credential. Install Azure CLI, ensure az is on PATH, run az login, then restart npm run dev."
      : status === 401 || /credential|authentication/i.test(code)
        ? "Entra authentication failed. Run az login and retry."
        : status === 403
          ? "Foundry access denied. Confirm your project role assignment."
          : fallback;
  sendJson(socket, { type: "bridge.error", error: { code, message } });
  console.error(`[bridge] session failure (${code}) during ${stage}`);
}

function createSessionHandler(socket) {
  let connection = null;
  let eventPump = null;
  let commandQueue = Promise.resolve();
  let bufferedAudioBytes = 0;
  let started = false;
  let shuttingDown = false;

  // diagnostic only
  let diagnosticCommitted = false;

  // async function closeConnection() {
  //   if (shuttingDown) return;
  //   shuttingDown = true;
  //   if (connection) await connection.close().catch(() => { });
  //   if (eventPump) await Promise.race([
  //     eventPump,
  //     new Promise((resolve) => setTimeout(resolve, 1_000)),
  //   ]);
  // }
  async function closeConnection() {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log("[bridge] closing Foundry connection");

    if (connection) {
      await connection.close().catch((error) => {
        console.error(
          "[bridge] Foundry close failed:",
          error,
        );
      });

      connection = null;
    }

    if (eventPump) {
      await Promise.race([
        eventPump,
        new Promise((resolve) =>
          setTimeout(resolve, 1_000)
        ),
      ]);

      eventPump = null;
    }

    console.log("[bridge] Foundry connection closed");
  }

  async function start() {
    if (started) return;
    started = true;
    const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT?.trim();
    const agentName = process.env.FOUNDRY_VOICE_AGENT_NAME?.trim();
    const missing = [
      !endpoint && "FOUNDRY_PROJECT_ENDPOINT",
      !agentName && "FOUNDRY_VOICE_AGENT_NAME",
    ].filter(Boolean);
    if (missing.length > 0) {
      sendJson(socket, {
        type: "bridge.error",
        error: { code: "configuration_missing", message: `Set ${missing.join(" and ")} in .env.local.` },
      });
      return;
    }

    let stage = "agent lookup";
    try {
      const project = new AIProjectClient(endpoint, new DefaultAzureCredential());
      const agent = await project.agents.get(agentName, FEATURE_OPTIONS);
      console.dir(
        agent.versions?.latest?.definition,
        { depth: null }
      );
      // const turnDetection = agent.versions?.latest?.definition?.audio?.input?.turn_detection;
      // const configuredTurnDetection = turnDetection && typeof turnDetection === "object"
      //   ? { ...turnDetection, create_response: false }
      //   : { type: "server_vad", create_response: false };

      stage = "realtime connect";
      connection = await project.beta.voiceAgents.realtime.connect(agentName, {
        ...FEATURE_OPTIONS,
        store: false,
        connectionTimeoutInMs: 30_000,
      });

      eventPump = (async () => {
        for await (const event of connection) {
          console.log("[foundry]", event.type);

          if (event.type === "session.created") {
            console.log("[bridge] session.created");
            sendJson(socket, { type: "bridge.ready" });
          }

          // Agent audio -> Browser as binary WebSocket frame
          if (event.type === "response.output_audio.delta") {
            if (
              socket.readyState === WebSocket.OPEN &&
              event.delta &&
              event.delta.byteLength > 0
            ) {
              socket.send(event.delta, { binary: true });
            }
            continue;
          }

          switch (event.type) {
            case "input_audio_buffer.speech_started":
            case "input_audio_buffer.speech_stopped":
            case "input_audio_buffer.committed":
            case "conversation.item.input_audio_transcription.delta":
            case "conversation.item.input_audio_transcription.completed":
            case "conversation.item.input_audio_transcription.failed":
              console.dir(event, { depth: null });
              break;
          }

          // Browser ต้องได้รับ events ด้วย
          const normalized = normalizeFoundryVoiceEvent(event);
          if (normalized) {
            sendJson(socket, {
              type: "event",
              event: normalized,
            });
          }
        }

        if (socket.readyState === WebSocket.OPEN && !shuttingDown) {
          sendJson(socket, { type: "bridge.closed" });
        }
      })().catch((error) => {
        sendFailure(
          socket,
          error,
          "Foundry realtime connection failed.",
          stage
        );
        void closeConnection();
      });

      stage = "session setup";
      // eventPump = (async () => {
      //   for await (const event of connection) {
      //     console.log("[bridge] event:", event.type);
      //     if (event.type === "unknown") {
      //       console.log(
      //         "[bridge] unknown event:",
      //         event.eventType,
      //         JSON.stringify(event.rawEvent)
      //       );
      //     }

      //     if (
      //       event.type === "response.output_text.delta" ||
      //       event.type === "response.output_audio_transcript.delta"
      //     ) {
      //       console.log("[bridge] agent transcript:", event.delta);
      //     }

      //     if (event.type === "response.output_audio.delta") {
      //       console.log(
      //         "[bridge] agent audio:",
      //         event.delta?.byteLength ?? event.delta?.length ?? "?"
      //       );
      //     }

      //     if (event.type === "response.done") {
      //       console.log("[bridge] response done");
      //     }

      //     if (socket.readyState !== WebSocket.OPEN) break;
      //     if (event.type === "input_audio_buffer.committed") bufferedAudioBytes = 0;
      //     const normalized = normalizeFoundryVoiceEvent(event);
      //     if (normalized?.type === "error") {
      //       console.error("[bridge] Foundry realtime error", JSON.stringify(normalized.error));
      //     }
      //     if (normalized) sendJson(socket, { type: "event", event: normalized });
      //     if (event.type === "session.created") {
      //       console.log("[bridge] session.created");

      //       console.log("[bridge] configuring realtime session");
      //       // await connection.configureSession({
      //       //   type: "realtime",
      //       //   output_modalities: ["text"],
      //       //   audio: {
      //       //     input: {
      //       //       format: { type: "audio/pcm", rate: 24_000 },
      //       //       transcription: {
      //       //         model: process.env.AZURE_TRANSCRIPTION_DEPLOYMENT?.trim()
      //       //           || process.env.FOUNDRY_TRANSCRIPTION_MODEL?.trim()
      //       //           || "azure-speech",
      //       //       },
      //       //       turn_detection: configuredTurnDetection,
      //       //     },
      //       //   },
      //       // });
      //       // await connection.configureSession({
      //       //   type: "realtime",
      //       //   output_modalities: ["text", "audio"],
      //       //   audio: {
      //       //     output: {
      //       //       format: { type: "audio/pcm", rate: 24_000 },
      //       //     },
      //       //   },
      //       // });
      //       sendJson(socket, { type: "bridge.ready" });

      //       // setTimeout(async () => {
      //       //   console.log("[bridge] sending text smoke test");
      //       //   try {
      //       //     await connection.sendText(
      //       //       "Co-Sales กรุณาตอบสั้น ๆ ว่า เชื่อมต่อสำเร็จ"
      //       //     );
      //       //     console.log("[bridge] sendText completed");
      //       //   } catch (error) {
      //       //     console.error("[bridge] sendText failed", error);
      //       //   }
      //       // }, 1000);
      //     }
      //   }
      //   if (socket.readyState === WebSocket.OPEN && !shuttingDown) {
      //     sendJson(socket, { type: "bridge.closed" });
      //   }
      // })().catch((error) => {
      //   sendFailure(socket, error, "Foundry realtime connection failed. Check local Azure access and bridge output.", stage);
      //   void closeConnection();
      // });
    } catch (error) {
      sendFailure(socket, error, "Foundry voice session could not start. Check the endpoint, agent, and local Azure access.", stage);
      await closeConnection();
    }
  }

  async function handleMessage(data, isBinary) {
    if (isBinary) {
      if (!connection || shuttingDown) return;
      // const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // console.log(
      //   "[bridge] browser audio:",
      //   bytes.byteLength,
      //   "bytes",
      //   "first:",
      //   bytes.subarray(0, 12)
      // );
      // await connection.sendAudio(bytes);
      // bufferedAudioBytes += bytes.byteLength;
      // console.log(
      //   "[bridge] total browser audio:",
      //   bufferedAudioBytes,
      //   "bytes"
      // );

      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

      // Important: give the Azure SDK a plain Uint8Array,
      // not a Node.js Buffer.
      const audio = Uint8Array.from(buffer);

      await connection.sendAudio(audio);

      bufferedAudioBytes += audio.byteLength;

      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendJson(socket, { type: "bridge.error", error: { code: "invalid_message", message: "Invalid bridge message." } });
      return;
    }

    if (message.type === "start") {
      await start();
    } else if (message.type === "response.create" && connection && !shuttingDown) {
      if (message.response?.conversation !== "none" || message.response?.output_modalities?.length !== 1 || message.response?.output_modalities?.[0] !== "text") {
        sendJson(socket, { type: "bridge.error", error: { code: "invalid_response", message: "Only silent out-of-band text responses are allowed." } });
        return;
      }
      await connection.requestResponse({ response: message.response });
    } else if (message.type === "tool.output" && connection && !shuttingDown) {
      if (typeof message.callId !== "string" || typeof message.output !== "string") return;
      await connection.sendToolOutput(message.callId, message.output, { createResponse: false });
    } else if (message.type === "audio.finish" && connection && !shuttingDown) {
      const hadAudio = bufferedAudioBytes >= PCM_BYTES_PER_SAMPLE;
      if (hadAudio) {
        await connection.commitAudio();
        bufferedAudioBytes = 0;
      }
      sendJson(socket, { type: "bridge.control", event: "audio_flush_complete", hadAudio });
    } else if (message.type === "stop") {
      await closeConnection();
    }
  }



  socket.on("message", (data, isBinary) => {
    commandQueue = commandQueue
      .then(() => handleMessage(data, isBinary))
      .catch((error) => {
        console.error("[bridge] COMMAND ERROR:", error);
        console.error("[bridge] COMMAND ERROR stack:", error?.stack);

        sendFailure(
          socket,
          error,
          "A Foundry voice operation failed.",
          "command"
        );
      });
  });
  socket.on("close", () => { void closeConnection(); });
  socket.on("error", () => { void closeConnection(); });
}

const server = createServer((request, response) => {
  response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!ALLOWED_ORIGINS.has(origin) || !["127.0.0.1:8787", "localhost:8787"].includes(host)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (request.url !== "/voice") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

webSocketServer.on("connection", (socket) => createSessionHandler(socket));
server.listen(PORT, HOST, () => console.log(`[bridge] listening on ws://${HOST}:${PORT}/voice`));

function stopBridge() {
  webSocketServer.clients.forEach((socket) => socket.close(1001, "Bridge shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", stopBridge);
process.on("SIGTERM", stopBridge);