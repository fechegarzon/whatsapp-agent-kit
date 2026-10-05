/**
 * Sends a signed, synthetic inbound message to your local server, the same
 * way Meta would. Handy for trying the kit without a real WhatsApp number.
 *
 *   npm run dev
 *   npm run simulate -- "what are your office hours?"
 */
import { signPayload } from "../src/webhook/signature.js";

const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3000}/webhook`;
const secret = process.env.WHATSAPP_APP_SECRET;
if (!secret) {
  console.error("Set WHATSAPP_APP_SECRET (same value as the server).");
  process.exit(1);
}

const text = process.argv.slice(2).join(" ") || "hi there";
const from = process.env.SIMULATE_FROM ?? "15555550123"; // fictional number

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "200000000000002",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15555550100", phone_number_id: "100000000000001" },
            contacts: [{ wa_id: from, profile: { name: "Sim User" } }],
            messages: [
              {
                from,
                id: `wamid.sim.${Date.now()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": signPayload(body, secret) },
  body,
});
console.log(`${res.status} ${await res.text()}`);
