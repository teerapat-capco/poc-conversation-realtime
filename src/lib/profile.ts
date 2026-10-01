import { z } from "zod";

export const customerProfileSchema = z.object({
  personal: z.object({
    age: z.number().int().min(0).max(120).nullable(),
    heightCm: z.number().min(30).max(260).nullable(),
    occupation: z.string().nullable(),
  }),
  financial: z.object({
    monthlyIncome: z.number().min(0).nullable(),
    monthlyExpenses: z.number().min(0).nullable(),
  }),
  goals: z.object({
    retirement: z.object({
      targetAge: z.number().int().min(0).max(120).nullable(),
      monthlyTarget: z.number().min(0).nullable(),
    }),
  }),
});

export type CustomerProfile = z.infer<typeof customerProfileSchema>;

export const initialProfile: CustomerProfile = {
  personal: { age: null, heightCm: null, occupation: null },
  financial: { monthlyIncome: null, monthlyExpenses: null },
  goals: { retirement: { targetAge: null, monthlyTarget: null } },
};

export type ProfileField =
  | "personal.age"
  | "personal.heightCm"
  | "personal.occupation"
  | "financial.monthlyIncome"
  | "financial.monthlyExpenses"
  | "goals.retirement.targetAge"
  | "goals.retirement.monthlyTarget";

export function updateProfileField(
  profile: CustomerProfile,
  field: ProfileField,
  value: number | string | null,
): CustomerProfile {
  const next = structuredClone(profile);
  const [section, key, nestedKey] = field.split(".");

  if (section === "personal" && key in next.personal) {
    next.personal[key as keyof CustomerProfile["personal"]] = value as never;
  } else if (section === "financial" && key in next.financial) {
    next.financial[key as keyof CustomerProfile["financial"]] = value as never;
  } else if (section === "goals" && key === "retirement" && nestedKey) {
    next.goals.retirement[nestedKey as keyof CustomerProfile["goals"]["retirement"]] = value as never;
  }

  return customerProfileSchema.parse(next);
}
