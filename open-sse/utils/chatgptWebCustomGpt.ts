import { z } from "zod";

const CUSTOM_GPT_ID_RE = /^g-[A-Za-z0-9]{1,128}$/;
const FUSED_SLUG_RE = /^(g-[A-Fa-f0-9]{32})-[A-Za-z0-9-]+$/;
const customGptInputSchema = z.object({
  custom_gpt_id: z.string().max(130).nullable().optional(),
  custom_gpt_url: z.string().max(2048).nullable().optional(),
});

export const INVALID_CUSTOM_GPT_ID_CODE = "INVALID_CUSTOM_GPT_ID";
export const CUSTOM_GPT_NOT_ACCESSIBLE_CODE = "CUSTOM_GPT_NOT_ACCESSIBLE";
export const INVALID_CUSTOM_GPT_MESSAGE =
  "The supplied Custom GPT does not have a valid ID in the g-... format.";
export const CUSTOM_GPT_NOT_ACCESSIBLE_MESSAGE =
  "The Custom GPT does not exist or this ChatGPT account cannot open it.";

/** Malformed or ambiguous Custom GPT selection, rejected before any browser work. */
export class CustomGptInputError extends Error {
  readonly code = INVALID_CUSTOM_GPT_ID_CODE;
  readonly status = 400;

  constructor(message = INVALID_CUSTOM_GPT_MESSAGE) {
    super(message);
    this.name = "CustomGptInputError";
  }
}

/**
 * ChatGPT answers a conversation for a private, deleted, or unshared GPT with 404. That is a
 * client configuration error, so it surfaces as 400: a 404 would put the whole ChatGPT Web
 * connection into the not-found cooldown and block unrelated requests on the same account.
 */
export class CustomGptNotAccessibleError extends Error {
  readonly code = CUSTOM_GPT_NOT_ACCESSIBLE_CODE;
  readonly status = 400;

  constructor() {
    super(CUSTOM_GPT_NOT_ACCESSIBLE_MESSAGE);
    this.name = "CustomGptNotAccessibleError";
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
  // Current share links fuse the slug into the ID segment: g-<32 hex>-my-gpt.
  const fusedSlug = FUSED_SLUG_RE.exec(parts[1]);
  if (!fusedSlug) return invalidCustomGpt();
  return fusedSlug[1];
}

/** Resolve the `custom_gpt_id` / `custom_gpt_url` request extensions and reject ambiguity. */
export function resolveCustomGptId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
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

/** The first-party `/f/conversation` call reports upstream statuses through its error text. */
export function isConversationNotFoundError(error: unknown): boolean {
  return error instanceof Error && /\bconversation failed with status 404\b/.test(error.message);
}

/** Request-mode payload for a fresh conversation; no mutable global GPT selection exists. */
export function chatGptWebConversationMode(customGptId?: string | null): Record<string, string> {
  return customGptId
    ? { kind: "gizmo_interaction", gizmo_id: customGptId }
    : { kind: "primary_assistant" };
}
