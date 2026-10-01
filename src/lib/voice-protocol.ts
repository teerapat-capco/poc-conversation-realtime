export type FoundryVoiceEvent = {
  type?: string;
  item_id?: string;
  previous_item_id?: string | null;
  delta?: string;
  transcript?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  };
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { type?: string; code?: string; status?: number; param?: string; event_id?: string; message?: string };
};

const realtimeErrorHints = [
  "session.update",
  "audio/pcm",
  "transcription",
  "turn_detection",
  "output_modalities",
  "input_audio_buffer",
  "unsupported",
  "not supported",
  "invalid",
  "model",
] as const;

export function isExtractionResponse(
  metadata: Record<string, unknown> | undefined,
  extractionId: string,
) {
  return metadata?.purpose === "customer_profile_extraction"
    && metadata.extractionId === extractionId;
}

export function normalizeFoundryVoiceEvent(event: FoundryVoiceEvent) {
  switch (event.type) {
    case "session.created":
    case "input_audio_buffer.speech_started":
    case "input_audio_buffer.speech_stopped":
      return { type: event.type };
    case "input_audio_buffer.committed":
      return {
        type: event.type,
        item_id: event.item_id,
        previous_item_id: event.previous_item_id,
      };
    case "conversation.item.input_audio_transcription.delta":
      return { type: event.type, item_id: event.item_id, delta: event.delta };
    case "conversation.item.input_audio_transcription.completed":
      return { type: event.type, item_id: event.item_id, transcript: event.transcript };
    case "conversation.item.input_audio_transcription.failed":
      return { type: event.type, item_id: event.item_id };
    case "response.created":
    case "response.done":
      return {
        type: event.type,
        response: event.response && {
          id: event.response.id,
          status: event.response.status,
          metadata: event.response.metadata,
        },
      };
    case "response.function_call_arguments.done":
      return {
        type: "response.output_item.done",
        response_id: event.response_id,
        item: {
          type: "function_call",
          call_id: event.call_id,
          name: event.name,
          arguments: event.arguments,
        },
      };
    case "error":
      const errorMessage = event.error?.message?.toLowerCase() ?? "";
      return {
        type: "error",
        error: {
          type: event.error?.type,
          code: event.error?.code,
          status: event.error?.status,
          param: event.error?.param,
          event_id: event.error?.event_id,
          diagnosticHints: realtimeErrorHints.filter((hint) => errorMessage.includes(hint)),
        },
      };
    default:
      return null;
  }
}