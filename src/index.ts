import { serve } from "@hono/node-server";
import { AnthropicAgent } from "./agent/anthropic-agent.js";
import { FaqAgent } from "./agent/faq-agent.js";
import type { Agent } from "./agent/types.js";
import { createApp } from "./app.js";
import { BackgroundTasks } from "./background.js";
import { loadConfig } from "./config.js";
import { MemoryConversationStore } from "./conversation/store.js";
import { createLogger } from "./logger.js";
import { GuardedSender } from "./outbound/sender.js";
import { GraphApiTransport, type Transport } from "./outbound/transport.js";
import { MemoryIdempotencyStore } from "./store/idempotency.js";
import { MemoryContactStateStore, ServiceWindow } from "./store/service-window.js";
import { WebhookProcessor } from "./webhook/processor.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

const transport: Transport =
  config.WHATSAPP_ACCESS_TOKEN && config.WHATSAPP_PHONE_NUMBER_ID
    ? new GraphApiTransport({
        accessToken: config.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiVersion: config.GRAPH_API_VERSION,
      })
    : {
        // Only reachable if DRY_RUN is false, and config validation blocks that combination.
        send: async () => {
          throw new Error("No WhatsApp credentials configured");
        },
      };

const agent: Agent = config.ANTHROPIC_API_KEY
  ? new AnthropicAgent({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, logger })
  : new FaqAgent();

const window = new ServiceWindow(new MemoryContactStateStore());
const switches = {
  agentEnabled: config.AGENT_ENABLED,
  dryRun: config.DRY_RUN,
  allowlist: config.OUTBOUND_ALLOWLIST,
};

const processor = new WebhookProcessor({
  idempotency: new MemoryIdempotencyStore(),
  window,
  conversations: new MemoryConversationStore(),
  agent,
  sender: new GuardedSender(transport, window, switches, logger),
  agentEnabled: config.AGENT_ENABLED,
  logger,
});

const background = new BackgroundTasks(logger);
const app = createApp({
  appSecret: config.WHATSAPP_APP_SECRET,
  verifyToken: config.WHATSAPP_VERIFY_TOKEN,
  processor,
  background,
  logger,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info("server.started", {
    port: info.port,
    agent: agent.name,
    agentEnabled: switches.agentEnabled,
    dryRun: switches.dryRun,
    allowlist: switches.allowlist.length,
  });
});

async function shutdown(signal: string) {
  logger.info("server.stopping", { signal, inFlight: background.size });
  server.close();
  await background.drain();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
