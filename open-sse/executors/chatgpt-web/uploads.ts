import { randomUUID } from "node:crypto";

import {
  tlsFetchChatGpt,
  type TlsFetchOptions,
  type TlsFetchResult,
} from "../../services/chatgptTlsClient.ts";

const FILES_URL = "https://chatgpt.com/backend-api/files";
const PROCESS_UPLOAD_URL = "https://chatgpt.com/backend-api/files/process_upload_stream";
const PREPARE_CONVERSATION_URL = "https://chatgpt.com/backend-api/f/conversation/prepare";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 100_000_000;

type UploadFetch = (url: string, options: TlsFetchOptions) => Promise<TlsFetchResult>;

export class ChatGptImageInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ChatGptImageInputError";
  }
}

export interface ChatGptInputImage {
  bytes: Uint8Array;
  fileName: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

interface UploadedImage {
  fileId: string;
  fileName: string;
  mimeType: "image/jpeg" | "image/png";
  sizeBytes: number;
  width: number;
  height: number;
}

export interface ChatGptImageUploadContext {
  conversationBody: Record<string, unknown>;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
  log?: { info?: (tag: string, message: string) => void } | null;
  fetchImpl?: UploadFetch;
}

export interface ChatGptImageUploadResult {
  conduitToken: string;
  images: UploadedImage[];
}

function imageError(message: string): never {
  throw new ChatGptImageInputError(message, 400, "INVALID_CHATGPT_WEB_IMAGE");
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (sofMarkers.has(marker) && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function decodeImageDataUrl(value: string, index: number): ChatGptInputImage {
  const match = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) {
    return imageError("ChatGPT Web image input must be a PNG or JPEG base64 data URL.");
  }
  const encoded = match[2];
  if (!encoded || encoded.length % 4 !== 0) return imageError("Invalid base64 image data.");
  if (encoded.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
    throw new ChatGptImageInputError(
      "ChatGPT Web image input exceeds the 10 MiB per-image limit.",
      413,
      "CHATGPT_WEB_IMAGE_TOO_LARGE"
    );
  }

  const bytes = Buffer.from(encoded, "base64");
  const canonicalInput = encoded.replace(/=+$/, "");
  if (bytes.toString("base64").replace(/=+$/, "") !== canonicalInput) {
    return imageError("Invalid base64 image data.");
  }
  if (bytes.length === 0) return imageError("Image data cannot be empty.");
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new ChatGptImageInputError(
      "ChatGPT Web image input exceeds the 10 MiB per-image limit.",
      413,
      "CHATGPT_WEB_IMAGE_TOO_LARGE"
    );
  }

  const mimeType = match[1].toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
  const dimensions =
    mimeType === "image/png" ? readPngDimensions(bytes) : readJpegDimensions(bytes);
  if (!dimensions) return imageError(`Image bytes do not match the declared ${mimeType} type.`);
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_DIMENSION ||
    dimensions.height > MAX_DIMENSION ||
    dimensions.width * dimensions.height > MAX_PIXELS
  ) {
    return imageError("Image dimensions are invalid or exceed the supported limit.");
  }

  const extension = mimeType === "image/png" ? "png" : "jpg";
  return {
    bytes,
    fileName: `omniroute-image-${index + 1}-${randomUUID().slice(0, 8)}.${extension}`,
    mimeType,
    ...dimensions,
  };
}

function imageUrlFromPart(part: Record<string, unknown>): string | null {
  if (part.type !== "image_url" && part.type !== "input_image") return null;
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url === "object" && !Array.isArray(part.image_url)) {
    const url = (part.image_url as Record<string, unknown>).url;
    return typeof url === "string" ? url : imageError("image_url.url must be a string.");
  }
  return imageError("image_url must contain a base64 data URL.");
}

/** Extract only the newest user turn's images, matching stateless text replay behavior. */
export function extractChatGptInputImages(
  messages: Array<Record<string, unknown>>
): ChatGptInputImage[] {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser || !Array.isArray(latestUser.content)) return [];

  const urls: string[] = [];
  for (const rawPart of latestUser.content) {
    if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) continue;
    const url = imageUrlFromPart(rawPart as Record<string, unknown>);
    if (url) urls.push(url);
  }
  if (urls.length > MAX_IMAGES) {
    throw new ChatGptImageInputError(
      `ChatGPT Web accepts at most ${MAX_IMAGES} input images per request.`,
      400,
      "INVALID_CHATGPT_WEB_IMAGE"
    );
  }

  const images = urls.map(decodeImageDataUrl);
  const totalBytes = images.reduce((total, image) => total + image.bytes.length, 0);
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new ChatGptImageInputError(
      "ChatGPT Web image input exceeds the 20 MiB aggregate limit.",
      413,
      "CHATGPT_WEB_IMAGE_TOO_LARGE"
    );
  }
  return images;
}

function parseJson(text: string | null, stage: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The stage-only error below intentionally excludes the upstream body.
  }
  throw new ChatGptImageInputError(
    `ChatGPT Web returned an invalid ${stage} response.`,
    502,
    "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
  );
}

function assertSuccess(response: TlsFetchResult, stage: string, accepted = [200]): void {
  if (!accepted.includes(response.status)) {
    throw new ChatGptImageInputError(
      `ChatGPT Web image ${stage} failed with HTTP ${response.status}.`,
      response.status === 401 || response.status === 403 ? 401 : 502,
      response.status === 401 || response.status === 403
        ? "CHATGPT_WEB_SESSION_EXPIRED"
        : "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
}

function validateSignedUploadUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new ChatGptImageInputError(
      "ChatGPT Web did not return an image upload URL.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChatGptImageInputError(
      "ChatGPT Web returned an invalid image upload URL.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !host.endsWith(".oaiusercontent.com") ||
    !url.pathname.endsWith("/raw") ||
    !url.search
  ) {
    throw new ChatGptImageInputError(
      "ChatGPT Web returned an untrusted image upload URL.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
  return url.toString();
}

function prepareBody(conversationBody: Record<string, unknown>, images: ChatGptInputImage[]) {
  return {
    action: "next",
    conversation_id: conversationBody.conversation_id ?? null,
    parent_message_id: conversationBody.parent_message_id,
    model: conversationBody.model,
    client_prepare_state: "success",
    client_prepare_dispatch: "debounced",
    client_prepare_source: "file_picker",
    timezone_offset_min: conversationBody.timezone_offset_min,
    conversation_mode: conversationBody.conversation_mode,
    system_hints: [],
    attachment_mime_types: images.map((image) => image.mimeType),
    supports_buffering: true,
    supported_encodings: ["v1"],
    ...(conversationBody.thinking_effort
      ? { thinking_effort: conversationBody.thinking_effort }
      : {}),
  };
}

async function prepareConversation(
  images: ChatGptInputImage[],
  ctx: ChatGptImageUploadContext,
  fetchImpl: UploadFetch
): Promise<string> {
  const response = await fetchImpl(PREPARE_CONVERSATION_URL, {
    method: "POST",
    headers: { ...ctx.headers, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(prepareBody(ctx.conversationBody, images)),
    timeoutMs: 30_000,
    signal: ctx.signal,
  });
  assertSuccess(response, "prepare");
  const parsed = parseJson(response.text, "image prepare");
  if (parsed.status !== "ok" || typeof parsed.conduit_token !== "string") {
    throw new ChatGptImageInputError(
      "ChatGPT Web did not prepare the image conversation.",
      502,
      "CHATGPT_WEB_IMAGE_PREPARE_FAILED"
    );
  }
  return parsed.conduit_token;
}

function parseProcessingResponse(text: string | null, expectedFileId: string): void {
  const events = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^data:\s*/, ""))
    .filter((line) => line && line !== "[DONE]")
    .map((line) => parseJson(line, "image processing"));
  if (events.length === 0) {
    throw new ChatGptImageInputError(
      "ChatGPT Web returned no image processing status.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
  for (const event of events) {
    if (event.file_id !== undefined && event.file_id !== expectedFileId) {
      throw new ChatGptImageInputError(
        "ChatGPT Web returned mismatched image processing state.",
        502,
        "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
      );
    }
    if (typeof event.event === "string" && /error|fail/i.test(event.event)) {
      throw new ChatGptImageInputError(
        "ChatGPT Web failed to process the uploaded image.",
        502,
        "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
      );
    }
  }
  const last = events[events.length - 1];
  const terminalProgress = typeof last.progress === "number" && last.progress >= 1;
  const terminalEvent = typeof last.event === "string" && /complete|success|done/i.test(last.event);
  if (!terminalProgress && !terminalEvent) {
    throw new ChatGptImageInputError(
      "ChatGPT Web image processing did not complete.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
}

async function uploadOne(
  image: ChatGptInputImage,
  temporaryChat: boolean,
  ctx: ChatGptImageUploadContext,
  fetchImpl: UploadFetch
): Promise<UploadedImage> {
  const allocation = await fetchImpl(FILES_URL, {
    method: "POST",
    headers: { ...ctx.headers, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: image.fileName,
      file_size: image.bytes.length,
      use_case: "multimodal",
      timezone_offset_min: ctx.conversationBody.timezone_offset_min,
      reset_rate_limits: false,
      supports_direct_azure_multipart: true,
      mime_type: image.mimeType,
    }),
    timeoutMs: 30_000,
    signal: ctx.signal,
  });
  assertSuccess(allocation, "allocation");
  const allocationBody = parseJson(allocation.text, "image allocation");
  if (allocationBody.status !== "success") {
    throw new ChatGptImageInputError(
      "ChatGPT Web did not allocate the image upload.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
  const fileId = allocationBody.file_id;
  if (typeof fileId !== "string" || !/^file[_-][A-Za-z0-9_-]{8,200}$/.test(fileId)) {
    throw new ChatGptImageInputError(
      "ChatGPT Web returned an invalid image file ID.",
      502,
      "CHATGPT_WEB_IMAGE_UPLOAD_FAILED"
    );
  }
  const uploadUrl = validateSignedUploadUrl(allocationBody.upload_url);

  const upload = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: {
      Accept: "*/*",
      "Content-Type": image.mimeType,
      Origin: "https://chatgpt.com",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2020-04-08",
    },
    body: image.bytes,
    followRedirects: false,
    timeoutMs: 60_000,
    signal: ctx.signal,
  });
  assertSuccess(upload, "transfer", [200, 201, 204]);

  const processing = await fetchImpl(PROCESS_UPLOAD_URL, {
    method: "POST",
    headers: {
      ...ctx.headers,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_id: fileId,
      use_case: "multimodal",
      index_for_retrieval: false,
      file_name: image.fileName,
      metadata: { is_temporary_chat: temporaryChat, is_project_thread: false },
    }),
    timeoutMs: 60_000,
    signal: ctx.signal,
  });
  assertSuccess(processing, "processing");
  parseProcessingResponse(processing.text, fileId);
  return {
    fileId,
    fileName: image.fileName,
    mimeType: image.mimeType,
    sizeBytes: image.bytes.length,
    width: image.width,
    height: image.height,
  };
}

export async function uploadChatGptInputImages(
  images: ChatGptInputImage[],
  ctx: ChatGptImageUploadContext
): Promise<ChatGptImageUploadResult> {
  if (ctx.signal?.aborted) throw ctx.signal.reason;
  const fetchImpl = ctx.fetchImpl ?? tlsFetchChatGpt;
  const conduitToken = await prepareConversation(images, ctx, fetchImpl);
  const uploaded: UploadedImage[] = [];
  for (const image of images) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    uploaded.push(
      await uploadOne(
        image,
        ctx.conversationBody.history_and_training_disabled === true,
        ctx,
        fetchImpl
      )
    );
  }
  ctx.log?.info?.("CGPT-WEB", `Uploaded ${uploaded.length} image attachment(s)`);
  return { conduitToken, images: uploaded };
}

export function attachChatGptInputImages(
  conversationBody: Record<string, unknown>,
  images: UploadedImage[]
): void {
  const messages = conversationBody.messages;
  if (!Array.isArray(messages)) return imageError("ChatGPT Web conversation messages are invalid.");
  const userMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).author &&
        ((message as Record<string, unknown>).author as Record<string, unknown>).role === "user"
    ) as Record<string, unknown> | undefined;
  if (!userMessage) return imageError("ChatGPT Web user message is missing.");

  const priorContent = userMessage.content as { parts?: unknown[] } | undefined;
  const text = typeof priorContent?.parts?.[0] === "string" ? priorContent.parts[0] : "";
  userMessage.create_time = Date.now() / 1000;
  userMessage.content = {
    content_type: "multimodal_text",
    parts: [
      ...images.map((image) => ({
        content_type: "image_asset_pointer",
        asset_pointer: `sediment://${image.fileId}`,
        size_bytes: image.sizeBytes,
        width: image.width,
        height: image.height,
      })),
      text,
    ],
  };
  userMessage.metadata = {
    attachments: images.map((image) => ({
      id: image.fileId,
      size: image.sizeBytes,
      name: image.fileName,
      mime_type: image.mimeType,
      width: image.width,
      height: image.height,
      source: "local",
      is_big_paste: false,
    })),
    selected_sources: [],
    serialization_metadata: { custom_symbol_offsets: [] },
  };
  conversationBody.client_prepare_state = "success";
}
