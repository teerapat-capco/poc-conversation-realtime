import { z } from "zod";

const configSchema = z.object({
  FOUNDRY_PROJECT_ENDPOINT: z.string().trim().url().optional().or(z.literal("")),
  FOUNDRY_VOICE_AGENT_NAME: z.string().trim().optional(),
});

const requiredNames = [
  "FOUNDRY_PROJECT_ENDPOINT",
  "FOUNDRY_VOICE_AGENT_NAME",
] as const;

export function getFoundryConfigStatus() {
  const parsed = configSchema.safeParse(process.env);

  if (!parsed.success) {
    return {
      configured: false,
      missing: ["FOUNDRY_PROJECT_ENDPOINT (must be a valid URL)"],
    };
  }

  const missing = requiredNames.filter((name) => !parsed.data[name]);
  return { configured: missing.length === 0, missing };
}
