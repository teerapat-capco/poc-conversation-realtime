"use client";

import { useEffect, useRef, useState } from "react";
import {
  initialProfile,
  updateProfileField,
  type CustomerProfile,
  type ProfileField,
} from "@/lib/profile";
import {
  extractionInstructions,
  classifyProfilePatch,
  PROFILE_PATCH_TOOL_NAME,
  profilePatchTool,
} from "@/lib/profile-patch";
import {
  buildExtractionInput,
  MAX_EXTRACTION_ATTEMPTS,
  MAX_CONTEXT_ITEMS,
  settleExtractionItems,
} from "@/lib/extraction";

type ConfigStatus = { configured: boolean; missing: readonly string[] };
type LogEntry = { id: number; time: string; message: string };
type TranscriptEntry = { itemId: string; text: string; complete: boolean };
type ExtractionRun = {
  id: string;
  conversationVersion: number;
  itemIds: string[];
  responseId: string | null;
  toolCalled: boolean;
  patchProcessed: boolean;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<boolean>;
  resolve: (succeeded: boolean) => void;
};
type ExtractionState = {
  dirty: boolean;
  stopping: boolean;
  conversationVersion: number;
  active: ExtractionRun | null;
  scheduledTimer: ReturnType<typeof setTimeout> | null;
  responseToExtraction: Map<string, string>;
  pendingItemIds: string[];
  contextItemIds: string[];
  retryCounts: Map<string, number>;
  manualFields: Set<ProfileField>;
  provenance: Map<ProfileField, { evidence: string; operation: string; at: string }>;
};
type RealtimeSession = {
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  stream: MediaStream | null;
  closed: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  extraction: ExtractionState;
  speechPendingCommit: boolean;
  audioFlushResolver: (() => void) | null;
  audioFlushTimer: ReturnType<typeof setTimeout> | null;
  audioCommitEventId: string | null;
  audioCommitFallbackRequested: boolean;
};

const MAX_LOG_ENTRIES = 30;
const DISCONNECTED_GRACE_MS = 5_000;
const EXTRACTION_INTERVAL_MS = 10_000;
const EXTRACTION_TIMEOUT_MS = 15_000;
const AUDIO_FLUSH_GRACE_MS = 2_000;
const AUDIO_FLUSH_TIMEOUT_MS = 5_000;

function getProfileFieldValue(profile: CustomerProfile, field: ProfileField) {
  switch (field) {
    case "personal.age": return profile.personal.age;
    case "personal.heightCm": return profile.personal.heightCm;
    case "personal.occupation": return profile.personal.occupation;
    case "financial.monthlyIncome": return profile.financial.monthlyIncome;
    case "financial.monthlyExpenses": return profile.financial.monthlyExpenses;
    case "goals.retirement.targetAge": return profile.goals.retirement.targetAge;
    case "goals.retirement.monthlyTarget": return profile.goals.retirement.monthlyTarget;
  }
}

function closeSession(session: RealtimeSession) {
  if (session.closed) return;
  session.closed = true;
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  session.disconnectTimer = null;
  if (session.extraction.scheduledTimer) clearTimeout(session.extraction.scheduledTimer);
  session.extraction.scheduledTimer = null;
  if (session.extraction.active) {
    clearTimeout(session.extraction.active.timer);
    session.extraction.active.resolve(false);
  }
  session.extraction.active = null;
  if (session.audioFlushTimer) clearTimeout(session.audioFlushTimer);
  session.audioFlushTimer = null;
  session.audioFlushResolver?.();
  session.audioFlushResolver = null;
  session.channel?.close();
  session.peer?.getSenders().forEach((sender) => sender.track?.stop());
  session.peer?.close();
  session.stream?.getTracks().forEach((track) => track.stop());
}

function finishAudioFlush(session: RealtimeSession) {
  if (session.audioFlushTimer) clearTimeout(session.audioFlushTimer);
  session.audioFlushTimer = null;
  session.audioCommitEventId = null;
  const resolve = session.audioFlushResolver;
  session.audioFlushResolver = null;
  resolve?.();
}

function scheduleAudioFlushTimer(session: RealtimeSession, delay: number, log: (message: string) => void) {
  if (session.audioFlushTimer) clearTimeout(session.audioFlushTimer);
  session.audioFlushTimer = setTimeout(() => {
    if (session.speechPendingCommit && !session.audioCommitFallbackRequested) {
      session.audioCommitFallbackRequested = true;
      const eventId = `stop-commit-${crypto.randomUUID()}`;
      session.audioCommitEventId = eventId;
      try {
        session.channel?.send(JSON.stringify({ event_id: eventId, type: "input_audio_buffer.commit" }));
        log("VAD commit not received · requested final audio commit");
        scheduleAudioFlushTimer(session, AUDIO_FLUSH_GRACE_MS, log);
      } catch {
        log("Final audio commit could not be sent · continuing with confirmed commits");
        finishAudioFlush(session);
      }
      return;
    }
    log(session.audioCommitEventId
      ? "Audio commit confirmation timed out · continuing with confirmed commits"
      : "Audio flush grace period elapsed · continuing with confirmed commits");
    finishAudioFlush(session);
  }, delay);
}

function Field({
  label,
  field,
  value,
  type = "number",
  suffix,
  onChange,
}: {
  label: string;
  field: ProfileField;
  value: number | string | null;
  type?: "number" | "text";
  suffix?: string;
  onChange: (field: ProfileField, value: number | string | null) => void;
}) {
  const id = field.replaceAll(".", "-");
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="input-wrap">
        <input
          id={id}
          type={type}
          min={type === "number" ? 0 : undefined}
          step={field === "personal.heightCm" ? 0.1 : 1}
          value={value ?? ""}
          placeholder="Not provided"
          onChange={(event) => {
            const raw = event.target.value;
            onChange(field, raw === "" ? null : type === "number" ? Number(raw) : raw);
          }}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </span>
    </label>
  );
}

export function ProfileWorkspace({ config }: { config: ConfigStatus }) {
  const [profile, setProfile] = useState<CustomerProfile>(initialProfile);
  const [status, setStatus] = useState("Not connected");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [events, setEvents] = useState<LogEntry[]>([
    { id: 1, time: "", message: "Workspace ready. Start listening to connect to Azure Realtime." },
  ]);
  const nextId = useRef(2);
  const profileRef = useRef(profile);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const sessionVersion = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setEvents((current) => current.map((event) =>
        event.id === 1 ? { ...event, time: new Date().toLocaleTimeString() } : event,
      ));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    sessionVersion.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) closeSession(session);
  }, []);

  function log(message: string) {
    const id = nextId.current++;
    setEvents((current) => [
      { id, time: new Date().toLocaleTimeString(), message },
      ...current,
    ].slice(0, MAX_LOG_ENTRIES));
  }

  function saveProfile(next: CustomerProfile) {
    profileRef.current = next;
    setProfile(next);
  }

  function completeExtraction(session: RealtimeSession, responseCompleted: boolean) {
    const extraction = session.extraction;
    const run = extraction.active;
    if (!run) return;
    clearTimeout(run.timer);
    if (extraction.conversationVersion !== run.conversationVersion) extraction.dirty = true;
    const succeeded = responseCompleted && run.toolCalled && run.patchProcessed;
    const settled = settleExtractionItems(
      extraction.pendingItemIds,
      extraction.retryCounts,
      run.itemIds,
      succeeded,
    );
    extraction.pendingItemIds = settled.pendingItemIds;
    extraction.retryCounts = settled.retryCounts;
    settled.exhaustedIds.forEach((itemId) => {
      log(`Extraction abandoned · ${itemId.slice(0, 8)} after ${MAX_EXTRACTION_ATTEMPTS} attempts`);
    });
    extraction.dirty = extraction.pendingItemIds.length > 0;
    extraction.responseToExtraction.forEach((mappedId, responseId) => {
      if (mappedId === run.id) extraction.responseToExtraction.delete(responseId);
    });
    extraction.active = null;
    run.resolve(succeeded);
    if (extraction.dirty && !extraction.scheduledTimer && !extraction.stopping && !session.closed) {
      extraction.scheduledTimer = setTimeout(() => {
        extraction.scheduledTimer = null;
        void requestExtraction(session, false);
      }, EXTRACTION_INTERVAL_MS);
    }
  }

  function requestExtraction(session: RealtimeSession, final: boolean): Promise<boolean> {
    const extraction = session.extraction;
    if (session.closed || session.channel?.readyState !== "open") return Promise.resolve(false);
    if (extraction.active) return extraction.active.promise;
    if (!extraction.dirty) return Promise.resolve(true);
    if (extraction.scheduledTimer) {
      clearTimeout(extraction.scheduledTimer);
      extraction.scheduledTimer = null;
    }

    const id = crypto.randomUUID();
    const conversationVersion = extraction.conversationVersion;
    const itemIds = [...extraction.pendingItemIds];
    const { contextIds, input } = buildExtractionInput(extraction.contextItemIds, itemIds);
    const profileContext = JSON.stringify(profileRef.current);
    let resolveRun!: (succeeded: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { resolveRun = resolve; });
    const timer = setTimeout(() => {
      if (extraction.active?.id !== id) return;
      log(`Extraction timeout · ${id.slice(0, 8)}`);
      completeExtraction(session, false);
    }, EXTRACTION_TIMEOUT_MS);
    extraction.active = {
      id,
      conversationVersion,
      itemIds,
      responseId: null,
      toolCalled: false,
      patchProcessed: false,
      timer,
      promise,
      resolve: resolveRun,
    };
    extraction.dirty = false;
    log(`${final ? "Final e" : "E"}xtraction requested · ${id.slice(0, 8)}`);

    try {
      session.channel.send(JSON.stringify({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["text"],
          metadata: { purpose: "customer_profile_extraction", extractionId: id },
          instructions: `${extractionInstructions}\n\nUse earlier conversation item references only to resolve the meaning of short replies. Extract or correct facts only from the explicitly marked new committed audio items. Treat the current profile as a baseline, not evidence: do not repeat unchanged values, and use "correct" only when the new audio clearly corrects a baseline value.\nContext item IDs: ${contextIds.join(", ") || "none"}. New item IDs: ${itemIds.join(", ")}.\n\nCurrent profile state: ${profileContext}`,
          input,
          tools: [profilePatchTool],
          tool_choice: "required",
        },
      }));
    } catch {
      log(`Extraction error · ${id.slice(0, 8)} could not be sent`);
      completeExtraction(session, false);
    }
    return promise;
  }

  function handleProfilePatch(session: RealtimeSession, raw: string) {
    const classified = classifyProfilePatch(raw);
    if (!classified.success) {
      log(`Patch rejected · ${classified.reason}`);
      return false;
    }

    let next = profileRef.current;
    let changedCount = 0;
    for (const skipped of classified.skipped) {
      log(`Patch skipped · ${skipped.field} · ${skipped.reason}`);
    }
    for (const update of classified.accepted) {
      if (session.extraction.manualFields.has(update.field)) {
        log(`Patch skipped · ${update.field} is manually owned`);
        continue;
      }
      const currentValue = getProfileFieldValue(next, update.field);
      if (Object.is(currentValue, update.value)) {
        log(`Patch unchanged · ${update.field}`);
        continue;
      }
      next = updateProfileField(next, update.field, update.value);
      session.extraction.provenance.set(update.field, {
        evidence: update.evidence,
        operation: update.operation,
        at: new Date().toISOString(),
      });
      changedCount += 1;
      log(`Profile changed · ${update.field}`);
    }
    if (changedCount > 0) saveProfile(next);
    const updateCount = classified.accepted.length + classified.skipped.length;
    log(`Patch processed · ${updateCount} update${updateCount === 1 ? "" : "s"}`);
    return true;
  }

  function handleFieldChange(field: ProfileField, value: number | string | null) {
    const session = sessionRef.current;
    if (session) session.extraction.manualFields.add(field);
    saveProfile(updateProfileField(profileRef.current, field, value));
    log(`Manual edit · ${field}`);
  }

  function endSession(session: RealtimeSession, version: number, nextStatus: string, message: string) {
    if (session.closed || version !== sessionVersion.current || sessionRef.current !== session) return;
    closeSession(session);
    sessionRef.current = null;
    setStatus(nextStatus);
    setIsListening(false);
    log(message);
  }

  async function handleStart() {
    if (!config.configured) {
      setStatus("Configuration required");
      log("Cannot start · Azure configuration is incomplete");
      return;
    }

    if (sessionRef.current && !sessionRef.current.closed) return;

    const version = ++sessionVersion.current;
    const session: RealtimeSession = {
      peer: null,
      channel: null,
      stream: null,
      closed: false,
      disconnectTimer: null,
      speechPendingCommit: false,
      audioFlushResolver: null,
      audioFlushTimer: null,
      audioCommitEventId: null,
      audioCommitFallbackRequested: false,
      extraction: {
        dirty: false,
        stopping: false,
        conversationVersion: 0,
        active: null,
        scheduledTimer: null,
        responseToExtraction: new Map(),
        pendingItemIds: [],
        contextItemIds: [],
        retryCounts: new Map(),
        manualFields: new Set(),
        provenance: new Map(),
      },
    };
    sessionRef.current = session;
    setStatus("Requesting microphone");
    setIsListening(false);
    setTranscript([]);
    log("Microphone access requested");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (version !== sessionVersion.current || session.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;

      setStatus("Connecting to Azure");
      const tokenResponse = await fetch("/api/realtime/token", { method: "POST", cache: "no-store" });
      const tokenPayload = await tokenResponse.json() as { token?: string; endpoint?: string; error?: string };
      if (!tokenResponse.ok || !tokenPayload.token || !tokenPayload.endpoint) {
        throw new Error(tokenPayload.error ?? "Could not obtain a Realtime token.");
      }
      if (version !== sessionVersion.current || session.closed) {
        closeSession(session);
        return;
      }

      const peer = new RTCPeerConnection();
      session.peer = peer;
      session.stream.getAudioTracks().forEach((track) => peer.addTrack(track, session.stream!));
      const channel = peer.createDataChannel("realtime-events");
      session.channel = channel;

      channel.onopen = () => {
        if (session.closed || version !== sessionVersion.current) return;
        if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
        setStatus("Connected · listening");
        setIsListening(true);
        log("Realtime connected · microphone is live");
      };
      channel.onclose = () => {
        endSession(session, version, "Connection closed", "Realtime data channel closed · session stopped");
      };
      channel.onmessage = (message) => {
        if (session.closed || version !== sessionVersion.current) return;
        try {
          const event = JSON.parse(message.data) as {
            type?: string;
            event_id?: string;
            response_id?: string;
            response?: {
              id?: string;
              status?: string;
              metadata?: { purpose?: string; extractionId?: string };
            };
            item?: { type?: string; name?: string; arguments?: string };
            item_id?: string;
            previous_item_id?: string | null;
            transcript?: string;
            delta?: string;
            error?: { event_id?: string; message?: string };
          };
          const itemId = event.item_id ?? "unknown-item";
          if (event.type === "input_audio_buffer.speech_started") {
            session.speechPendingCommit = true;
            if (session.audioFlushResolver) {
              scheduleAudioFlushTimer(session, AUDIO_FLUSH_TIMEOUT_MS, log);
            }
          } else if (event.type === "input_audio_buffer.speech_stopped") {
            log("Speech stopped · waiting for VAD commit");
          } else if (event.type === "input_audio_buffer.committed" && event.item_id) {
            const extraction = session.extraction;
            session.speechPendingCommit = false;
            extraction.dirty = true;
            extraction.conversationVersion += 1;
            if (!extraction.pendingItemIds.includes(event.item_id)) {
              extraction.pendingItemIds.push(event.item_id);
            }
            extraction.contextItemIds = [
              ...extraction.contextItemIds.filter((id) => id !== event.item_id),
              event.item_id,
            ].slice(-MAX_CONTEXT_ITEMS);
            finishAudioFlush(session);
            if (!extraction.active && !extraction.scheduledTimer && !extraction.stopping) {
              extraction.scheduledTimer = setTimeout(() => {
                extraction.scheduledTimer = null;
                void requestExtraction(session, false);
              }, EXTRACTION_INTERVAL_MS);
            }
            setTranscript((current) => current.some((entry) => entry.itemId === itemId)
              ? current
              : [...current, { itemId, text: "", complete: false }].slice(-100));
          } else if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
            setTranscript((current) => {
              const existing = current.find((entry) => entry.itemId === itemId);
              if (!existing) return [...current, { itemId, text: event.delta!, complete: false }].slice(-100);
              return current.map((entry) => entry.itemId === itemId
                ? { ...entry, text: entry.text + event.delta }
                : entry);
            });
          } else if (event.type === "conversation.item.input_audio_transcription.completed") {
            setTranscript((current) => {
              const existing = current.some((entry) => entry.itemId === itemId);
              if (!existing) return [...current, { itemId, text: event.transcript ?? "", complete: true }].slice(-100);
              return current.map((entry) => entry.itemId === itemId
                ? { ...entry, text: event.transcript ?? entry.text, complete: true }
                : entry);
            });
          } else if (event.type === "conversation.item.input_audio_transcription.failed") {
            log("Input transcription failed for an audio segment");
          } else if (event.type === "response.created" && event.response?.id) {
            const metadata = event.response.metadata;
            const run = session.extraction.active;
            if (
              run &&
              metadata?.purpose === "customer_profile_extraction" &&
              metadata.extractionId === run.id
            ) {
              run.responseId = event.response.id;
              session.extraction.responseToExtraction.set(event.response.id, run.id);
            }
          } else if (event.type === "response.function_call_arguments.done") {
            const extractionId = event.response_id
              ? session.extraction.responseToExtraction.get(event.response_id)
              : undefined;
            if (extractionId && session.extraction.active?.id === extractionId) {
              session.extraction.active.toolCalled = true;
            }
          } else if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
            const extractionId = event.response_id
              ? session.extraction.responseToExtraction.get(event.response_id)
              : undefined;
            const run = session.extraction.active;
            if (extractionId && run?.id === extractionId) {
              run.toolCalled = true;
              if (event.item.name !== PROFILE_PATCH_TOOL_NAME || typeof event.item.arguments !== "string") {
                log(`Patch rejected · unexpected tool call · ${extractionId.slice(0, 8)}`);
              } else {
                log(`Function called · ${PROFILE_PATCH_TOOL_NAME} · ${extractionId.slice(0, 8)}`);
                run.patchProcessed = handleProfilePatch(session, event.item.arguments);
              }
            }
          } else if (event.type === "response.done") {
            const response = event.response;
            const extractionId = (response?.id && session.extraction.responseToExtraction.get(response.id))
              || (response?.metadata?.purpose === "customer_profile_extraction" ? response.metadata.extractionId : undefined);
            if (extractionId && session.extraction.active?.id === extractionId) {
              session.extraction.responseToExtraction.delete(response?.id ?? "");
              if (!session.extraction.active.toolCalled) {
                log(`Extraction error · ${extractionId.slice(0, 8)} completed without a function call`);
              }
              completeExtraction(session, response?.status === "completed");
            }
          } else if (event.type === "error") {
            log(`Realtime error · ${event.error?.message ?? "see session configuration"}`);
            if (event.error?.event_id && event.error.event_id === session.audioCommitEventId) {
              session.audioCommitEventId = null;
              log("Final audio commit failed · continuing with confirmed commits");
              finishAudioFlush(session);
            }
          }
        } catch {
          log("Received an unreadable Realtime event");
        }
      };
      peer.onconnectionstatechange = () => {
        if (session.closed || version !== sessionVersion.current) return;
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          endSession(session, version, "Connection failed", "Realtime connection became unavailable · session stopped");
        } else if (peer.connectionState === "disconnected") {
          if (!session.disconnectTimer) {
            session.disconnectTimer = setTimeout(() => {
              session.disconnectTimer = null;
              if (peer.connectionState === "disconnected") {
                endSession(session, version, "Connection lost", "Realtime connection did not recover · session stopped");
              }
            }, DISCONNECTED_GRACE_MS);
          }
        } else if (session.disconnectTimer) {
          clearTimeout(session.disconnectTimer);
          session.disconnectTimer = null;
        }
      };

      const offer = await peer.createOffer();
      if (version !== sessionVersion.current || session.closed) return;
      await peer.setLocalDescription(offer);
      if (version !== sessionVersion.current || session.closed) return;
      const answerResponse = await fetch(`${tokenPayload.endpoint}/openai/v1/realtime/calls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPayload.token}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!answerResponse.ok) {
        throw new Error(`Azure WebRTC negotiation failed (HTTP ${answerResponse.status}). Check the Azure endpoint and deployment.`);
      }
      const answerSdp = await answerResponse.text();
      if (version !== sessionVersion.current || session.closed) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (error) {
      if (version !== sessionVersion.current || session.closed) return;
      closeSession(session);
      sessionRef.current = null;
      setStatus("Connection failed");
      setIsListening(false);
      const message = error instanceof Error ? error.message : "An unexpected connection error occurred.";
      log(message.toLowerCase().includes("permission") || message.toLowerCase().includes("denied")
        ? "Microphone access was denied"
        : `Connection error · ${message}`);
    }
  }

  async function handleStop() {
    const session = sessionRef.current;
    if (!session || session.closed || session.extraction.stopping) return;
    session.extraction.stopping = true;
    if (session.extraction.scheduledTimer) clearTimeout(session.extraction.scheduledTimer);
    session.extraction.scheduledTimer = null;
    setStatus("Finishing audio · waiting for VAD commit");
    log("Stop requested · waiting for pending audio commit");

    const flushAudio = new Promise<void>((resolve) => {
      session.audioFlushResolver = resolve;
      scheduleAudioFlushTimer(
        session,
        session.speechPendingCommit ? AUDIO_FLUSH_TIMEOUT_MS : AUDIO_FLUSH_GRACE_MS,
        log,
      );
    });
    session.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    setIsListening(false);
    await flushAudio;
    if (session.closed) return;
    setStatus("Finishing extraction · microphone muted");
    log("Audio flush complete · extracting committed speech");

    const deadline = Date.now() + EXTRACTION_TIMEOUT_MS * 2 + 1_000;
    while (!session.closed && Date.now() < deadline) {
      const active = session.extraction.active;
      if (active) {
        await active.promise;
        continue;
      }
      if (!session.extraction.dirty) break;
      await requestExtraction(session, true);
    }

    if (sessionRef.current === session && !session.closed) {
      if (session.extraction.dirty) log("Final extraction timed out · closing session");
      sessionVersion.current += 1;
      closeSession(session);
      sessionRef.current = null;
      setIsListening(false);
      setStatus("Not connected");
      log("Session stopped · microphone and connection closed");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">R</div>
        <div className="brand-copy">
          <p className="eyebrow">Realtime conversation · proof of concept</p>
          <h1>Customer profile</h1>
        </div>
        <div className="session-controls">
          <span className="status-pill"><span className="status-dot" />{status}</span>
          <button className="button button-primary" onClick={handleStart} disabled={isListening || status === "Connecting to Azure" || status === "Requesting microphone"}>Start listening</button>
          <button className="button button-secondary" onClick={handleStop}>Stop</button>
        </div>
      </header>

      {!config.configured && (
        <section className="config-alert" aria-live="polite">
          <div className="alert-icon" aria-hidden="true">!</div>
          <div>
            <h2>Azure configuration is incomplete</h2>
            <p>Add these values to <code>.env.local</code> when you are ready to connect:</p>
            <ul>{config.missing.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
          </div>
        </section>
      )}

      <div className="workspace-grid">
        <section className="main-column" aria-label="Customer information">
          <div className="section-heading">
            <div><p className="eyebrow">Shared session model</p><h2>Customer details</h2></div>
            <span className="edit-note"><span aria-hidden="true">✎</span> Fields are editable</span>
          </div>

          <section className="profile-card">
            <div className="card-heading"><span className="step">01</span><div><h3>Know your customer</h3><p>Personal details</p></div><span className="card-tag">KYC</span></div>
            <div className="field-grid">
              <Field label="Age" field="personal.age" value={profile.personal.age} suffix="years" onChange={handleFieldChange} />
              <Field label="Height" field="personal.heightCm" value={profile.personal.heightCm} suffix="cm" onChange={handleFieldChange} />
              <Field label="Occupation" field="personal.occupation" value={profile.personal.occupation} type="text" onChange={handleFieldChange} />
            </div>
          </section>

          <section className="profile-card">
            <div className="card-heading"><span className="step">02</span><div><h3>Financial needs</h3><p>Monthly cash flow</p></div><span className="card-tag">FNA</span></div>
            <div className="field-grid">
              <Field label="Monthly income" field="financial.monthlyIncome" value={profile.financial.monthlyIncome} suffix="THB / month" onChange={handleFieldChange} />
              <Field label="Monthly expenses" field="financial.monthlyExpenses" value={profile.financial.monthlyExpenses} suffix="THB / month" onChange={handleFieldChange} />
            </div>
          </section>

          <section className="profile-card">
            <div className="card-heading"><span className="step">03</span><div><h3>Retirement goal</h3><p>Customer’s future target</p></div><span className="card-tag">GOAL</span></div>
            <div className="field-grid">
              <Field label="Target retirement age" field="goals.retirement.targetAge" value={profile.goals.retirement.targetAge} suffix="years" onChange={handleFieldChange} />
              <Field label="Monthly target" field="goals.retirement.monthlyTarget" value={profile.goals.retirement.monthlyTarget} suffix="THB / month" onChange={handleFieldChange} />
            </div>
          </section>

          <details className="model-preview">
            <summary>Shared customer model <span>JSON preview</span></summary>
            <pre>{JSON.stringify(profile, null, 2)}</pre>
          </details>
        </section>

        <aside className="side-column">
          <section className="side-card transcript-card">
            <div className="side-card-heading"><div><p className="eyebrow">Live session</p><h2>Transcript</h2></div><span className={`listening-indicator${isListening ? " active" : ""}`}><i /> {isListening ? "listening" : "idle"}</span></div>
            {transcript.length === 0 ? <div className="transcript-empty"><div className="wave-icon" aria-hidden="true"><span /><span /><span /><span /><span /></div><p>{isListening ? "Listening for conversation" : "Conversation transcript will appear here"}</p><span>{isListening ? "Speaker identity is not inferred" : "Start a session to begin"}</span></div> : <ol className="transcript-list" aria-live="polite">{transcript.map((entry) => <li key={entry.itemId}><span className="speaker-label">Speaker unknown</span><p>{entry.text || "Transcribing…"}{!entry.complete && <span className="transcript-cursor" aria-label="transcribing"> ▍</span>}</p></li>)}</ol>}
          </section>

          <section className="side-card event-card">
            <div className="side-card-heading"><div><p className="eyebrow">Session activity</p><h2>Event log</h2></div><span className="entry-count">{events.length} / {MAX_LOG_ENTRIES}</span></div>
            <ol className="event-list">{events.map((event) => <li key={event.id}><time>{event.time}</time><span>{event.message}</span></li>)}</ol>
          </section>

          <div className="privacy-note"><span aria-hidden="true">◈</span><p>Audio is streamed to Azure Realtime for live transcription. Profile edits stay in this browser session.</p></div>
        </aside>
      </div>
      <footer><span>POC · PHASE 3</span><span>Realtime profile extraction</span></footer>
    </main>
  );
}
