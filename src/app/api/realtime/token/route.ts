import { getAzureConfigStatus } from "@/lib/config";

export const runtime = "nodejs";

export async function POST() {
  const config = getAzureConfigStatus();
  if (!config.configured) {
    return Response.json(
      { error: `Azure configuration is incomplete: ${config.missing.join(", ")}` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/$/, "");
  const requestUrl = `${endpoint}/openai/v1/realtime/client_secrets`;

  try {
    const azureResponse = await fetch(requestUrl, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.AZURE_OPENAI_API_KEY!,
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: process.env.AZURE_REALTIME_DEPLOYMENT,
          audio: {
            input: {
              transcription: {
                model: process.env.AZURE_TRANSCRIPTION_DEPLOYMENT,
              },
              turn_detection: {
                type: "server_vad",
                create_response: false,
                interrupt_response: false,
              },
            },
          },
        },
      }),
    });

    if (!azureResponse.ok) {
      return Response.json(
        { error: `Azure could not create a Realtime token (HTTP ${azureResponse.status}). Check the endpoint, key, and deployment names.` },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const payload: unknown = await azureResponse.json();
    const token =
      typeof payload === "object" && payload !== null && "value" in payload &&
      typeof payload.value === "string"
        ? payload.value
        : typeof payload === "object" && payload !== null && "client_secret" in payload &&
          typeof payload.client_secret === "object" && payload.client_secret !== null &&
          "value" in payload.client_secret && typeof payload.client_secret.value === "string"
          ? payload.client_secret.value
          : null;

    if (!token) {
      return Response.json(
        { error: "Azure returned a token response in an unrecognized format." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      { token, endpoint },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Could not reach Azure to create a Realtime token." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
