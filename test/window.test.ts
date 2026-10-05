import { describe, expect, it } from "vitest";
import { WindowClosedError } from "../src/outbound/errors.js";
import { buildTemplate } from "../src/outbound/templates.js";
import { SERVICE_WINDOW_MS } from "../src/store/service-window.js";
import { CUSTOMER, OTHER_CUSTOMER, harness, payloadWith, textMessage } from "./helpers.js";

const HOUR = 60 * 60 * 1000;

describe("24-hour service window", () => {
  it("is closed for a contact who never wrote", async () => {
    const { window } = harness();
    expect(await window.isOpen(CUSTOMER)).toBe(false);
  });

  it("opens on an inbound message and closes before 24h (with the safety margin)", async () => {
    const { window, time } = harness();
    await window.recordInbound(CUSTOMER, time.nowSec());

    expect(await window.isOpen(CUSTOMER)).toBe(true);
    time.advance(23 * HOUR);
    expect(await window.isOpen(CUSTOMER)).toBe(true);
    time.advance(HOUR - 60_000); // 23h59m: inside 24h, but past the 5 minute margin
    expect(await window.isOpen(CUSTOMER)).toBe(false);
  });

  it("uses Meta's timestamp, so a late replay does not reopen the window", async () => {
    const { window, time } = harness();
    const sentAt = time.nowSec();
    time.advance(SERVICE_WINDOW_MS + HOUR);

    await window.recordInbound(CUSTOMER, sentAt);
    expect(await window.isOpen(CUSTOMER)).toBe(false);
  });

  it("never moves backwards on out-of-order deliveries", async () => {
    const { window, time } = harness();
    const now = time.nowSec();
    await window.recordInbound(CUSTOMER, now);
    await window.recordInbound(CUSTOMER, now - 30 * 60 * 60); // an old message delivered late

    expect(await window.isOpen(CUSTOMER)).toBe(true);
  });

  it("lets free-form text through while the window is open", async () => {
    const { window, sender, time, transport } = harness();
    await window.recordInbound(CUSTOMER, time.nowSec());

    await expect(sender.sendText(CUSTOMER, "hi")).resolves.toMatchObject({ status: "sent" });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed with WindowClosedError once the window is over", async () => {
    const { window, sender, time, transport } = harness();
    await window.recordInbound(CUSTOMER, time.nowSec());
    time.advance(25 * HOUR);

    const err = await sender.sendText(CUSTOMER, "following up!").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WindowClosedError);
    expect((err as WindowClosedError).code).toBe("window_closed");
    expect((err as WindowClosedError).closedAt).toBeTypeOf("number");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("fails closed for cold outreach to someone who never wrote", async () => {
    const { sender, transport } = harness();
    const err = await sender.sendText(OTHER_CUSTOMER, "hi! special offer").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WindowClosedError);
    expect((err as WindowClosedError).closedAt).toBeUndefined();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("allows an approved template outside the window", async () => {
    const { sender, time, transport } = harness();
    time.advance(48 * HOUR);
    const template = buildTemplate(
      { name: "visit_reminder", language: "en_US", body: "Hi {{1}}, your tour is on {{2}}." },
      ["Sam", "Friday at 10am"],
    );

    await expect(sender.sendTemplate(CUSTOMER, template)).resolves.toMatchObject({ status: "sent" });
    expect(transport.sent[0]).toMatchObject({ kind: "template", to: CUSTOMER });
  });

  it("refuses the agent's reply end to end when the window closed between inbound and reply", async () => {
    const h = harness();
    const oldTs = h.time.nowSec();
    h.time.advance(30 * HOUR); // the webhook arrives very late (e.g. after an outage)

    await h.post(payloadWith({ messages: [textMessage("wamid.late", "hello?", { timestampSec: oldTs })] }));

    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(await h.process.mock.results[0]?.value).toMatchObject({ messages: { "wamid.late": "refused" } });
  });
});
