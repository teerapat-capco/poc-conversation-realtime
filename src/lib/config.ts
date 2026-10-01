import { z } from "zod";

const configSchema = z.object({
  AZURE_OPENAI_ENDPOINT: z.string().trim().url().optional().or(z.literal("")),
  AZURE_OPENAI_API_KEY: z.string().trim().optional(),
  AZURE_REALTIME_DEPLOYMENT: z.string().trim().optional(),
  AZURE_TRANSCRIPTION_DEPLOYMENT: z.string().trim().optional(),
});

const requiredNames = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_REALTIME_DEPLOYMENT",
  "AZURE_TRANSCRIPTION_DEPLOYMENT",
] as const;

export function getAzureConfigStatus() {
  const parsed = configSchema.safeParse(process.env);

  if (!parsed.success) {
    return {
      configured: false,
      missing: ["AZURE_OPENAI_ENDPOINT (must be a valid URL)"],
    };
  }

  const missing = requiredNames.filter((name) => !parsed.data[name]);
  return { configured: missing.length === 0, missing };
}
