import { describe, expect, it } from "vitest";
import { TemplateValidationError } from "../src/outbound/errors.js";
import { buildTemplate, placeholdersOf } from "../src/outbound/templates.js";

const spec = { name: "visit_reminder", language: "en_US", body: "Hi {{1}}, your tour is on {{2}}." };

describe("template builder", () => {
  it("builds the Graph API template payload", () => {
    expect(buildTemplate(spec, ["Sam", "Friday"])).toEqual({
      name: "visit_reminder",
      language: { code: "en_US" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Sam" },
            { type: "text", text: "Friday" },
          ],
        },
      ],
    });
  });

  it("supports templates without variables", () => {
    expect(buildTemplate({ ...spec, body: "Thanks for reaching out." }, [])).toMatchObject({ components: [] });
  });

  it("allows a placeholder to repeat", () => {
    expect(placeholdersOf("{{1}} and {{2}}, then {{1}} again")).toEqual([1, 2]);
  });

  it.each([
    ["a gap", "Hi {{1}}, see you {{3}}"],
    ["not starting at 1", "Hi {{2}}"],
    ["a named variable", "Hi {{name}}"],
    ["an empty placeholder", "Hi {{}}"],
  ])("rejects a body with %s", (_label, body) => {
    expect(() => buildTemplate({ ...spec, body }, ["x", "y"])).toThrow(TemplateValidationError);
  });

  it("rejects the wrong number of parameters", () => {
    expect(() => buildTemplate(spec, ["Sam"])).toThrow(/needs 2 parameter/);
    expect(() => buildTemplate(spec, ["Sam", "Friday", "extra"])).toThrow(/needs 2 parameter/);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects an %s parameter", (_label, value) => {
    expect(() => buildTemplate(spec, ["Sam", value])).toThrow(/\{\{2\}\} is empty/);
  });

  it("rejects parameters Meta would refuse", () => {
    expect(() => buildTemplate(spec, ["Sam", "Friday\nat 10"])).toThrow(/new line/);
    expect(() => buildTemplate(spec, ["Sam", "Friday\tat 10"])).toThrow(/tab/);
    expect(() => buildTemplate(spec, ["Sam", "Friday     at 10"])).toThrow(/4 consecutive spaces/);
  });

  it("rejects a bad template name or language", () => {
    expect(() => buildTemplate({ ...spec, name: "Visit Reminder" }, ["a", "b"])).toThrow(TemplateValidationError);
    expect(() => buildTemplate({ ...spec, language: "english" }, ["a", "b"])).toThrow(TemplateValidationError);
  });

  it("errors carry a code callers can switch on", () => {
    try {
      buildTemplate(spec, []);
    } catch (e) {
      expect((e as TemplateValidationError).code).toBe("invalid_template");
    }
  });
});
