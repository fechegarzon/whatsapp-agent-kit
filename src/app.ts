import { Hono } from "hono";
import type { BackgroundTasks } from "./background.js";
import type { Logger } from "./logger.js";
import { WebhookPayloadSchema, type WebhookPayload } from "./webhook/schema.js";
import { safeEqual, verifySignature } from "./webhook/signature.js";

export interface AppDeps {
  appSecret: string;
  verifyToken: string;
  processor: { process(payload: WebhookPayload): Promise<unknown> };
  background: BackgroundTasks;
  logger: Logger;
}

export function createApp(deps: AppDeps): Hono {
  const { logger } = deps;
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Meta calls this once when you register the webhook URL.
  app.get("/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";

    if (mode === "subscribe" && safeEqual(token, deps.verifyToken)) {
      return c.text(challenge, 200);
    }
    logger.warn("webhook.verify_rejected", { mode });
    return c.text("Forbidden", 403);
  });

  app.post("/webhook", async (c) => {
    // Read raw bytes first: the signature covers the body exactly as sent.
    const raw = new Uint8Array(await c.req.arrayBuffer());

    if (!verifySignature(raw, c.req.header("x-hub-signature-256"), deps.appSecret)) {
      logger.warn("webhook.bad_signature");
      return c.text("Invalid signature", 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      logger.warn("webhook.bad_json");
      return c.text("Bad JSON", 400);
    }

    const parsed = WebhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      // The request is authentic, so it came from Meta. A non-200 here would
      // only make Meta retry the same payload for days. Log it and move on.
      logger.warn("webhook.unexpected_shape", {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return c.text("OK", 200);
    }

    // Answer fast. Meta expects a 200 within a few seconds and retries
    // otherwise; an LLM call can easily take longer than that.
    deps.background.run("webhook", () => deps.processor.process(parsed.data));
    return c.text("OK", 200);
  });

  return app;
}
