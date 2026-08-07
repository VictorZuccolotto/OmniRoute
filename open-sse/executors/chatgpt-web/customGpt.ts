import { z } from "zod";

const CUSTOM_GPT_ID_RE = /^g-[A-Za-z0-9]{1,128}$/;
const customGptInputSchema = z
  .object({
    custom_gpt_id: z.string().max(130).nullable().optional(),
    custom_gpt_url: z.string().max(2048).nullable().optional(),
  })
  .passthrough();

export const INVALID_CUSTOM_GPT_MESSAGE =
  "The supplied Custom GPT does not have a valid ID in the g-... format.";
export const CUSTOM_GPT_MISMATCH_MESSAGE =
  "The existing conversation is linked to a different Custom GPT.";

export class CustomGptInputError extends Error {
  readonly code = "INVALID_CUSTOM_GPT_ID";

  constructor(message = INVALID_CUSTOM_GPT_MESSAGE) {
    super(message);
    this.name = "CustomGptInputError";
  }
}

function invalidCustomGpt(): never {
  throw new CustomGptInputError();
}

/** Normalize a bare Custom GPT ID or a canonical chatgpt.com GPT URL. */
export function normalizeCustomGptId(value: string): string {
  const trimmed = value.trim();
  if (CUSTOM_GPT_ID_RE.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalidCustomGpt();
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (hostname !== "chatgpt.com" && hostname !== "www.chatgpt.com") ||
    url.port ||
    url.username ||
    url.password
  ) {
    return invalidCustomGpt();
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "g") return invalidCustomGpt();
  if (CUSTOM_GPT_ID_RE.test(parts[1])) return parts[1];
  const fusedSlug = /^(g-[A-Fa-f0-9]{32})-[A-Za-z0-9-]+$/.exec(parts[1]);
  if (!fusedSlug) return invalidCustomGpt();
  return fusedSlug[1];
}

/** Resolve the two OpenAI-compatible request extensions and reject ambiguity. */
export function resolveCustomGptId(body: unknown): string | null {
  const parsed = customGptInputSchema.safeParse(body);
  if (!parsed.success) throw new CustomGptInputError();

  const explicitId =
    parsed.data.custom_gpt_id == null ? null : normalizeCustomGptId(parsed.data.custom_gpt_id);
  const urlId =
    parsed.data.custom_gpt_url == null ? null : normalizeCustomGptId(parsed.data.custom_gpt_url);

  if (explicitId && urlId && explicitId !== urlId) {
    throw new CustomGptInputError("custom_gpt_id and custom_gpt_url refer to different GPTs.");
  }
  return explicitId ?? urlId;
}
