import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    WHATSAPP_APP_SECRET: z.string().min(1, "WHATSAPP_APP_SECRET is required"),
    WHATSAPP_VERIFY_TOKEN: z.string().min(1, "WHATSAPP_VERIFY_TOKEN is required"),
    WHATSAPP_ACCESS_TOKEN: z.preprocess(blankToUndefined, z.string().optional()),
    WHATSAPP_PHONE_NUMBER_ID: z.preprocess(blankToUndefined, z.string().regex(/^\d+$/).optional()),
    GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
    // Safe defaults: the agent is off and nothing leaves the process.
    AGENT_ENABLED: bool(false),
    DRY_RUN: bool(true),
    OUTBOUND_ALLOWLIST: csv,
    ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
    ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (!env.DRY_RUN && (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID)) {
      ctx.addIssue({
        code: "custom",
        path: ["DRY_RUN"],
        message: "DRY_RUN=false needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID",
      });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/** Fails at boot, not at the first message, if the environment is wrong. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
