import assert from "node:assert/strict";
import test from "node:test";

import {
  attachChatGptInputImages,
  ChatGptImageInputError,
  extractChatGptInputImages,
  uploadChatGptInputImages,
} from "../../open-sse/executors/chatgpt-web/uploads.ts";
import type { TlsFetchOptions, TlsFetchResult } from "../../open-sse/services/chatgptTlsClient.ts";
import { sanitizeHeaders } from "../../src/mitm/sanitizeHeaders.ts";

function pngDataUrl(width = 800, height = 600): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function response(status: number, text = "{}"): TlsFetchResult {
  return { status, headers: new Headers(), text, body: null };
}

function conversationBody(): Record<string, unknown> {
  return {
    action: "next",
    messages: [
      {
        id: "message-user",
        author: { role: "user" },
        content: { content_type: "text", parts: ["Describe this image"] },
      },
    ],
    model: "gpt-5-6-thinking",
    conversation_id: null,
    parent_message_id: "message-parent",
    timezone_offset_min: 180,
    history_and_training_disabled: true,
    conversation_mode: { kind: "gizmo_interaction", gizmo_id: "g-Test123" },
    thinking_effort: "extended",
  };
}

test("extractChatGptInputImages accepts n8n/OpenAI data URL parts", () => {
  const images = extractChatGptInputImages([
    {
      role: "user",
      content: [
        { type: "text", text: "Describe it" },
        { type: "image_url", image_url: { url: pngDataUrl(800, 600) } },
      ],
    },
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[0].width, 800);
  assert.equal(images[0].height, 600);
  assert.equal(images[0].bytes.length, 24);
  assert.match(images[0].fileName, /^omniroute-image-1-[a-f0-9]{8}\.png$/);
});

test("extractChatGptInputImages uploads only the newest user turn", () => {
  const images = extractChatGptInputImages([
    { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl(1, 1) } }] },
    { role: "assistant", content: "Earlier answer" },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: pngDataUrl(320, 240) } }],
    },
  ]);
  assert.equal(images.length, 1);
  assert.deepEqual(
    { width: images[0].width, height: images[0].height },
    { width: 320, height: 240 }
  );
});

test("extractChatGptInputImages rejects remote URLs, SVG, bad magic, and excess images", () => {
  const invalidParts = [
    { type: "image_url", image_url: { url: "https://example.com/private.png" } },
    { type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from("not-png").toString("base64")}` },
    },
  ];
  for (const part of invalidParts) {
    assert.throws(
      () => extractChatGptInputImages([{ role: "user", content: [part] }]),
      (error: unknown) =>
        error instanceof ChatGptImageInputError && error.code === "INVALID_CHATGPT_WEB_IMAGE"
    );
  }

  assert.throws(
    () =>
      extractChatGptInputImages([
        {
          role: "user",
          content: Array.from({ length: 5 }, () => ({
            type: "image_url",
            image_url: { url: pngDataUrl(1, 1) },
          })),
        },
      ]),
    /at most 4/
  );
});

test("upload flow follows captured prepare, allocate, PUT, and process protocol", async () => {
  const images = extractChatGptInputImages([
    { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl() } }] },
  ]);
  const body = conversationBody();
  const calls: Array<{ url: string; options: TlsFetchOptions }> = [];
  const uploadUrl = "https://files.oaiusercontent.com/files/upload-example/raw?sig=secret";
  const fetchImpl = async (url: string, options: TlsFetchOptions): Promise<TlsFetchResult> => {
    calls.push({ url, options });
    if (url.endsWith("/f/conversation/prepare")) {
      return response(200, JSON.stringify({ status: "ok", conduit_token: "conduit-secret" }));
    }
    if (url.endsWith("/backend-api/files")) {
      return response(
        200,
        JSON.stringify({ status: "success", upload_url: uploadUrl, file_id: "file_upload123456" })
      );
    }
    if (url === uploadUrl) return response(201, "");
    if (url.endsWith("/files/process_upload_stream")) {
      return response(
        200,
        [
          JSON.stringify({ file_id: "file_upload123456", event: "processing", progress: 0.5 }),
          JSON.stringify({ file_id: "file_upload123456", event: "complete", progress: 1 }),
        ].join("\n")
      );
    }
    return response(404);
  };

  const result = await uploadChatGptInputImages(images, {
    conversationBody: body,
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "chatgpt-account-id": "account-secret",
      "OAI-Device-Id": "device-secret",
      "openai-sentinel-proof-token": "sentinel-secret",
    },
    fetchImpl,
  });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/backend-api/f/conversation/prepare",
      "/backend-api/files",
      "/files/upload-example/raw",
      "/backend-api/files/process_upload_stream",
    ]
  );
  assert.equal(result.conduitToken, "conduit-secret");

  const prepare = JSON.parse(String(calls[0].options.body));
  assert.deepEqual(prepare.attachment_mime_types, ["image/png"]);
  assert.deepEqual(prepare.conversation_mode, {
    kind: "gizmo_interaction",
    gizmo_id: "g-Test123",
  });
  const transfer = calls[2].options;
  assert.ok(transfer.body instanceof Uint8Array);
  assert.equal(transfer.followRedirects, false);
  assert.deepEqual(transfer.headers, {
    Accept: "*/*",
    "Content-Type": "image/png",
    Origin: "https://chatgpt.com",
    "x-ms-blob-type": "BlockBlob",
    "x-ms-version": "2020-04-08",
  });
  assert.doesNotMatch(JSON.stringify(transfer.headers), /secret|authorization|cookie|sentinel/i);

  attachChatGptInputImages(body, result.images);
  const userMessage = (body.messages as Array<Record<string, unknown>>)[0];
  const content = userMessage.content as { content_type: string; parts: unknown[] };
  assert.equal(content.content_type, "multimodal_text");
  assert.deepEqual(content.parts[0], {
    content_type: "image_asset_pointer",
    asset_pointer: "sediment://file_upload123456",
    size_bytes: 24,
    width: 800,
    height: 600,
  });
  assert.equal(content.parts[1], "Describe this image");
  assert.equal(body.client_prepare_state, "success");
});

test("upload flow rejects untrusted signed upload hosts", async () => {
  const images = extractChatGptInputImages([
    { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl() } }] },
  ]);
  const fetchImpl = async (url: string): Promise<TlsFetchResult> => {
    if (url.endsWith("/f/conversation/prepare")) {
      return response(200, JSON.stringify({ status: "ok", conduit_token: "conduit" }));
    }
    return response(
      200,
      JSON.stringify({
        status: "success",
        upload_url: "https://oaiusercontent.com.evil.test/files/x/raw?sig=secret",
        file_id: "file_upload123456",
      })
    );
  };
  await assert.rejects(
    uploadChatGptInputImages(images, {
      conversationBody: conversationBody(),
      headers: {},
      fetchImpl,
    }),
    (error: unknown) =>
      error instanceof ChatGptImageInputError &&
      error.code === "CHATGPT_WEB_IMAGE_UPLOAD_FAILED" &&
      /untrusted/.test(error.message)
  );
});

test("concurrent uploads keep file and conduit state request-scoped", async () => {
  async function run(label: "alpha" | "beta") {
    const images = extractChatGptInputImages([
      { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl() } }] },
    ]);
    const body = conversationBody();
    const fileId = `file_${label}12345678`;
    const uploadUrl = `https://files.oaiusercontent.com/files/${label}/raw?sig=secret`;
    const fetchImpl = async (url: string): Promise<TlsFetchResult> => {
      await new Promise((resolve) => setTimeout(resolve, label === "alpha" ? 2 : 1));
      if (url.endsWith("/f/conversation/prepare")) {
        return response(200, JSON.stringify({ status: "ok", conduit_token: `conduit-${label}` }));
      }
      if (url.endsWith("/backend-api/files")) {
        return response(
          200,
          JSON.stringify({ status: "success", upload_url: uploadUrl, file_id: fileId })
        );
      }
      if (url === uploadUrl) return response(201, "");
      return response(200, JSON.stringify({ file_id: fileId, event: "complete", progress: 1 }));
    };
    const result = await uploadChatGptInputImages(images, {
      conversationBody: body,
      headers: {},
      fetchImpl,
    });
    attachChatGptInputImages(body, result.images);
    return { body, token: result.conduitToken };
  }

  const [alpha, beta] = await Promise.all([run("alpha"), run("beta")]);
  assert.equal(alpha.token, "conduit-alpha");
  assert.equal(beta.token, "conduit-beta");
  assert.match(JSON.stringify(alpha.body), /sediment:\/\/file_alpha12345678/);
  assert.doesNotMatch(JSON.stringify(alpha.body), /beta/);
  assert.match(JSON.stringify(beta.body), /sediment:\/\/file_beta12345678/);
  assert.doesNotMatch(JSON.stringify(beta.body), /alpha/);
});

test("an already-aborted upload performs no outbound request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let calls = 0;
  await assert.rejects(
    uploadChatGptInputImages(
      extractChatGptInputImages([
        { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl() } }] },
      ]),
      {
        conversationBody: conversationBody(),
        headers: {},
        signal: controller.signal,
        fetchImpl: async () => {
          calls++;
          return response(200);
        },
      }
    ),
    /cancelled/
  );
  assert.equal(calls, 0);
});

test("x-conduit-token is treated as a secret header", () => {
  assert.deepEqual(sanitizeHeaders({ "x-conduit-token": "conduit-secret" }), {
    "x-conduit-token": "[REDACTED]",
  });
});
