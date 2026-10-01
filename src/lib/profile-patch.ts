import { z } from "zod";
import type { ProfileField } from "@/lib/profile";

export const PROFILE_PATCH_TOOL_NAME = "submit_profile_patch";

const profileFields = [
  "personal.age",
  "personal.heightCm",
  "personal.occupation",
  "financial.monthlyIncome",
  "financial.monthlyExpenses",
  "goals.retirement.targetAge",
  "goals.retirement.monthlyTarget",
] as const satisfies readonly ProfileField[];

const profileUpdateSchema = z.object({
  operation: z.enum(["set", "correct"]),
  field: z.string().trim().min(1).max(80),
  value: z.union([z.string(), z.number(), z.null()]),
  sourceSpeaker: z.enum(["customer", "agent", "unknown"]),
  evidence: z.string().trim().min(1).max(240),
}).strict();

// Validate the envelope separately so one malformed update cannot discard
// other usable updates from the same model response.
export const profilePatchSchema = z.object({
  updates: z.array(z.unknown()).max(20),
}).strict();

export type ProfilePatch = { updates: z.infer<typeof profileUpdateSchema>[] };
export type ProfileUpdate = Omit<ProfilePatch["updates"][number], "field"> & { field: ProfileField };

const supportedProfileFields = new Set<string>(profileFields);

export function isProfileField(field: string): field is ProfileField {
  return supportedProfileFields.has(field);
}

export const profilePatchTool = {
  type: "function",
  name: PROFILE_PATCH_TOOL_NAME,
  description: "Submit only new or corrected customer profile facts supported by the conversation.",
  parameters: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["set", "correct"] },
            field: { type: "string", enum: profileFields },
            value: { type: ["string", "number", "null"] },
            sourceSpeaker: { type: "string", enum: ["customer", "agent", "unknown"] },
            evidence: { type: "string", description: "Short verbatim evidence quote from the customer." },
          },
          required: ["operation", "field", "value", "sourceSpeaker", "evidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["updates"],
    additionalProperties: false,
  },
} as const;

export const extractionInstructions = `You are a silent observer extracting customer facts from a live insurance conversation. Use the single function tool to return a small patch, never a full profile.

Only include facts directly stated or clearly confirmed by the customer. A seller's question, suggestion, or statement alone is not customer evidence. Do not infer speaker identity from voice or confidence. Treat a clear customer correction as operation "correct"; use "set" for a new fact. Do not guess, normalize beyond preserving the meaning, or include unsupported fields. If a seller asks a leading question, wait for the customer's confirmation; an ambiguous "yes" is usable only when its reference is clear. Keep evidence short and verbatim. If no new or corrected customer fact is supported, call the tool with {"updates":[]}. Never speak to the participants.`;

export function parseProfilePatch(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { success: false as const, reason: "Malformed JSON arguments" };
  }

  const parsed = profilePatchSchema.safeParse(value);
  return parsed.success
    ? { success: true as const, data: parsed.data }
    : { success: false as const, reason: "Arguments did not match the profile patch schema" };
}

const nonnegativeAmount = z.number().finite().min(0).max(1_000_000_000);
const fieldValueSchemas: Record<ProfileField, z.ZodType> = {
  "personal.age": z.number().int().min(0).max(120),
  "personal.heightCm": z.number().finite().min(30).max(260),
  "personal.occupation": z.string().trim().min(1).max(120),
  "financial.monthlyIncome": nonnegativeAmount,
  "financial.monthlyExpenses": nonnegativeAmount,
  "goals.retirement.targetAge": z.number().int().min(0).max(120),
  "goals.retirement.monthlyTarget": nonnegativeAmount,
};

export function validateProfileUpdate(update: ProfileUpdate) {
  if (update.sourceSpeaker !== "customer") {
    return { valid: false as const, reason: "Source speaker was not the customer" };
  }
  if (!fieldValueSchemas[update.field].safeParse(update.value).success) {
    return { valid: false as const, reason: "Value is outside the supported type or business range" };
  }
  return { valid: true as const };
}

export function classifyProfilePatch(raw: string) {
  const parsed = parseProfilePatch(raw);
  if (!parsed.success) return { success: false as const, reason: parsed.reason };

  const accepted: ProfileUpdate[] = [];
  const skipped: Array<{ field: string; reason: string }> = [];
  for (const candidate of parsed.data.updates) {
    const item = profileUpdateSchema.safeParse(candidate);
    if (!item.success) {
      const candidateField = typeof candidate === "object" && candidate !== null && "field" in candidate
        && typeof candidate.field === "string"
        ? candidate.field
        : "(unknown field)";
      skipped.push({ field: candidateField, reason: "Update did not match the profile update schema" });
      continue;
    }
    if (!isProfileField(item.data.field)) {
      skipped.push({ field: item.data.field, reason: "Unsupported profile field" });
      continue;
    }
    const update: ProfileUpdate = { ...item.data, field: item.data.field };
    const validation = validateProfileUpdate(update);
    if (!validation.valid) {
      skipped.push({ field: update.field, reason: validation.reason });
      continue;
    }
    accepted.push(update);
  }

  return { success: true as const, accepted, skipped };
}

export function partitionManualOwnedUpdates(
  updates: ProfileUpdate[],
  manualFields: ReadonlySet<ProfileField>,
) {
  const accepted: ProfileUpdate[] = [];
  const manuallyOwned: ProfileUpdate[] = [];
  for (const update of updates) {
    (manualFields.has(update.field) ? manuallyOwned : accepted).push(update);
  }
  return { accepted, manuallyOwned };
}
