import { TemplateValidationError } from "./errors.js";

/**
 * Template messages are the only way to reach someone outside the 24-hour
 * window. Meta rejects a template send when the parameters do not match the
 * approved body, and the error comes back asynchronously as a failed status.
 * Checking locally gives a clear error at the call site instead.
 */
export interface TemplateSpec {
  /** Name exactly as approved in WhatsApp Manager. */
  name: string;
  /** Language code the template was approved in, e.g. "en_US" or "es". */
  language: string;
  /** The approved body text, with {{1}}, {{2}}... placeholders. */
  body: string;
}

export interface TemplatePayload {
  name: string;
  language: { code: string };
  components: Array<{
    type: "body";
    parameters: Array<{ type: "text"; text: string }>;
  }>;
}

const NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Returns the placeholder numbers in the order they appear, after checking they are 1..n. */
export function placeholdersOf(body: string): number[] {
  const seen: number[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const raw = match[1] ?? "";
    if (!/^\d+$/.test(raw)) {
      throw new TemplateValidationError(`Placeholder {{${raw}}} is not a positional number`);
    }
    seen.push(Number(raw));
  }

  const unique = [...new Set(seen)].sort((a, b) => a - b);
  unique.forEach((n, i) => {
    if (n !== i + 1) {
      throw new TemplateValidationError(
        `Placeholders must be sequential starting at {{1}}; expected {{${i + 1}}} but found {{${n}}}`,
      );
    }
  });
  return unique;
}

export function buildTemplate(spec: TemplateSpec, params: readonly string[]): TemplatePayload {
  if (!NAME.test(spec.name)) {
    throw new TemplateValidationError(`Template name "${spec.name}" must be lowercase letters, digits and underscores`);
  }
  if (!LANGUAGE.test(spec.language)) {
    throw new TemplateValidationError(`Language "${spec.language}" does not look like a WhatsApp language code`);
  }

  const expected = placeholdersOf(spec.body).length;
  if (params.length !== expected) {
    throw new TemplateValidationError(`Template "${spec.name}" needs ${expected} parameter(s), got ${params.length}`);
  }

  params.forEach((p, i) => {
    const slot = `{{${i + 1}}}`;
    if (p.trim() === "") throw new TemplateValidationError(`Parameter ${slot} is empty`);
    // Meta rejects body parameters with new lines, tabs, or more than 4 spaces in a row.
    if (/[\n\t]/.test(p)) throw new TemplateValidationError(`Parameter ${slot} contains a new line or tab`);
    if (/ {5,}/.test(p)) throw new TemplateValidationError(`Parameter ${slot} has more than 4 consecutive spaces`);
  });

  return {
    name: spec.name,
    language: { code: spec.language },
    components:
      expected === 0 ? [] : [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
  };
}
