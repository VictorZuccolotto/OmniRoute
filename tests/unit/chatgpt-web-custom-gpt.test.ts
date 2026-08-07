import assert from "node:assert/strict";
import test from "node:test";

import {
  CustomGptInputError,
  normalizeCustomGptId,
  resolveCustomGptId,
} from "../../open-sse/executors/chatgpt-web/customGpt.ts";
import {
  ChatGptWebExecutor,
  __resetChatGptWebCachesForTesting,
} from "../../open-sse/executors/chatgpt-web.ts";
import { __setTlsFetchOverrideForTesting } from "../../open-sse/services/chatgptTlsClient.ts";
import { storeChatGptImage } from "../../open-sse/services/chatgptImageCache.ts";
import { protectPayloadForLog } from "../../src/lib/logPayloads.ts";

function headers(contentType: string): Headers {
  return new Headers({ "Content-Type": contentType });
}

function completionSse(answer = "Custom GPT answer"): string {
  const event = {
    conversation_id: "conversation-custom-gpt",
    message: {
      id: "message-custom-gpt",
      author: { role: "assistant" },
      content: { content_type: "text", parts: [answer] },
      status: "finished_successfully",
    },
  };
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

function pngDataUrl(): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(800, 16);
  bytes.writeUInt32BE(800, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function installMockTransport(conversationStatus = 200): {
  conversationBodies: Array<Record<string, unknown>>;
  conversationHeaders: Array<Record<string, string>>;
  requestUrls: string[];
  restore: () => void;
} {
  const conversationBodies: Array<Record<string, unknown>> = [];
  const conversationHeaders: Array<Record<string, string>> = [];
  const requestUrls: string[] = [];
  const uploadUrl = "https://files.oaiusercontent.com/files/custom-gpt-upload/raw?sig=test";

  __setTlsFetchOverrideForTesting(async (input, options = {}) => {
    const url = String(input);
    requestUrls.push(url);
    if (url === "https://chatgpt.com/" || url === "https://chatgpt.com") {
      return {
        status: 200,
        headers: headers("text/html"),
        text: '<html data-build="prod-test"><script src="https://cdn.oaistatic.com/main.js"></script></html>',
        body: null,
      };
    }
    if (url.endsWith("/api/auth/session")) {
      return {
        status: 200,
        headers: headers("application/json"),
        text: JSON.stringify({
          accessToken: "test-access-token",
          expires: new Date(Date.now() + 3_600_000).toISOString(),
          user: { id: "test-user" },
        }),
        body: null,
      };
    }
    if (url.includes("/sentinel/chat-requirements")) {
      return {
        status: 200,
        headers: headers("application/json"),
        text: JSON.stringify({ token: "requirements-token", proofofwork: { required: false } }),
        body: null,
      };
    }
    if (url.endsWith("/backend-api/f/conversation/prepare")) {
      return {
        status: 200,
        headers: headers("application/json"),
        text: JSON.stringify({ status: "ok", conduit_token: "conduit-test" }),
        body: null,
      };
    }
    if (url.endsWith("/backend-api/files")) {
      return {
        status: 200,
        headers: headers("application/json"),
        text: JSON.stringify({
          status: "success",
          upload_url: uploadUrl,
          file_id: "file_customgpt123456",
        }),
        body: null,
      };
    }
    if (url === uploadUrl) {
      return { status: 201, headers: headers("text/plain"), text: "", body: null };
    }
    if (url.endsWith("/backend-api/files/process_upload_stream")) {
      return {
        status: 200,
        headers: headers("text/event-stream"),
        text: JSON.stringify({
          file_id: "file_customgpt123456",
          event: "complete",
          progress: 1,
        }),
        body: null,
      };
    }
    if (url.endsWith("/backend-api/f/conversation")) {
      conversationBodies.push(JSON.parse(options.body ?? "{}") as Record<string, unknown>);
      conversationHeaders.push(options.headers ?? {});
      return {
        status: conversationStatus,
        headers: headers(conversationStatus === 200 ? "text/event-stream" : "application/json"),
        text:
          conversationStatus === 200
            ? completionSse()
            : JSON.stringify({ detail: "not found or inaccessible" }),
        body: null,
      };
    }
    return {
      status: 200,
      headers: headers("application/json"),
      text: "{}",
      body: null,
    };
  });

  return {
    conversationBodies,
    conversationHeaders,
    requestUrls,
    restore: () => __setTlsFetchOverrideForTesting(null),
  };
}

async function execute(
  body: Record<string, unknown>,
  options: { stream?: boolean; apiKey?: string } = {}
) {
  return new ChatGptWebExecutor().execute({
    model: "gpt-5.3-instant",
    body,
    stream: options.stream ?? false,
    credentials: { apiKey: options.apiKey ?? "test-cookie" },
    signal: AbortSignal.timeout(10_000),
    log: null,
  });
}

test("normalizeCustomGptId accepts canonical IDs and ChatGPT URLs", () => {
  assert.equal(normalizeCustomGptId(" g-AbC123 "), "g-AbC123");
  assert.equal(normalizeCustomGptId("https://chatgpt.com/g/g-AbC123/my-gpt"), "g-AbC123");
  assert.equal(normalizeCustomGptId("https://chatgpt.com/g/g-AbC123"), "g-AbC123");
  assert.equal(
    normalizeCustomGptId("https://www.chatgpt.com/g/g-AbC123/my-gpt?locale=pt-BR#start"),
    "g-AbC123"
  );
  assert.equal(
    normalizeCustomGptId(
      "https://chatgpt.com/g/g-6a524eb2094081919355945e8055dab4-agente-criador-copy-08"
    ),
    "g-6a524eb2094081919355945e8055dab4"
  );
});

test("normalizeCustomGptId rejects malformed IDs and non-ChatGPT URLs", () => {
  const invalid = [
    "",
    "g-",
    "g-has-hyphen",
    "G-AbC123",
    "https://example.com/g/g-AbC123/my-gpt",
    "http://chatgpt.com/g/g-AbC123/my-gpt",
    "https://chatgpt.com.evil.test/g/g-AbC123/my-gpt",
    "https://chatgpt.com:8443/g/g-AbC123/my-gpt",
    "https://chatgpt.com/not-g/g-AbC123",
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeCustomGptId(value), CustomGptInputError, value);
  }
});

test("resolveCustomGptId handles absence, matching fields, type errors, and conflicts", () => {
  assert.equal(resolveCustomGptId({}), null);
  assert.equal(resolveCustomGptId({ custom_gpt_id: null, custom_gpt_url: null }), null);
  assert.equal(
    resolveCustomGptId({
      custom_gpt_id: " g-AbC123 ",
      custom_gpt_url: "https://chatgpt.com/g/g-AbC123/my-gpt",
    }),
    "g-AbC123"
  );
  assert.throws(
    () => resolveCustomGptId({ custom_gpt_id: 123 }),
    (error: unknown) =>
      error instanceof CustomGptInputError && error.code === "INVALID_CUSTOM_GPT_ID"
  );
  assert.throws(
    () =>
      resolveCustomGptId({
        custom_gpt_id: "g-AbC123",
        custom_gpt_url: "https://chatgpt.com/g/g-Different456/other",
      }),
    /refer to different GPTs/
  );
});

test("executor preserves primary mode and sends gizmo mode for ID and URL inputs", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockTransport();
  try {
    const normal = await execute({ messages: [{ role: "user", content: "normal" }] });
    const byId = await execute(
      {
        custom_gpt_id: "g-First123",
        messages: [{ role: "user", content: "custom by id" }],
      },
      { stream: true }
    );
    const byUrl = await execute({
      custom_gpt_url: "https://chatgpt.com/g/g-Second456?source=test",
      messages: [{ role: "user", content: "custom by URL" }],
    });

    assert.equal(normal.response.status, 200);
    assert.equal(byId.response.headers.get("Content-Type"), "text/event-stream");
    assert.match(await byId.response.text(), /data: \[DONE\]/);
    assert.equal(byUrl.response.status, 200);
    assert.deepEqual(mock.conversationBodies[0].conversation_mode, { kind: "primary_assistant" });
    assert.deepEqual(mock.conversationBodies[1].conversation_mode, {
      kind: "gizmo_interaction",
      gizmo_id: "g-First123",
    });
    assert.deepEqual(mock.conversationBodies[2].conversation_mode, {
      kind: "gizmo_interaction",
      gizmo_id: "g-Second456",
    });
  } finally {
    mock.restore();
  }
});

test("executor rejects invalid and conflicting Custom GPT fields before upstream chat", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockTransport();
  try {
    for (const body of [
      { custom_gpt_id: "invalid" },
      {
        custom_gpt_id: "g-First123",
        custom_gpt_url: "https://chatgpt.com/g/g-Second456/other",
      },
    ]) {
      const result = await execute({ ...body, messages: [{ role: "user", content: "hi" }] });
      assert.equal(result.response.status, 400);
      assert.equal((await result.response.json()).error.code, "INVALID_CUSTOM_GPT_ID");
    }
    assert.equal(mock.conversationBodies.length, 0);
  } finally {
    mock.restore();
  }
});

test("executor maps inaccessible GPT and expired session errors to stable codes", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockTransport(404);
  try {
    const inaccessible = await execute({
      custom_gpt_id: "g-Missing123",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(inaccessible.response.status, 404);
    assert.equal((await inaccessible.response.json()).error.code, "CUSTOM_GPT_NOT_ACCESSIBLE");

    const expired = await execute({ messages: [{ role: "user", content: "hi" }] }, { apiKey: "" });
    assert.equal(expired.response.status, 401);
    assert.equal((await expired.response.json()).error.code, "CHATGPT_WEB_SESSION_EXPIRED");
  } finally {
    mock.restore();
  }
});

test("concurrent Custom GPT requests keep request and conversation state isolated", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockTransport();
  try {
    const ids = ["g-Shared123", "g-Shared123", "g-Other456", null];
    const results = await Promise.all(
      ids.map((id, index) =>
        execute({
          ...(id ? { custom_gpt_id: id } : {}),
          messages: [{ role: "user", content: `request ${index}` }],
        })
      )
    );
    assert.ok(results.every((result) => result.response.status === 200));

    const modes = mock.conversationBodies.map((body) => body.conversation_mode);
    assert.equal(
      modes.filter((mode) => (mode as { gizmo_id?: string }).gizmo_id === "g-Shared123").length,
      2
    );
    assert.equal(
      modes.filter((mode) => (mode as { gizmo_id?: string }).gizmo_id === "g-Other456").length,
      1
    );
    assert.equal(
      modes.filter((mode) => (mode as { kind?: string }).kind === "primary_assistant").length,
      1
    );
    assert.ok(mock.conversationBodies.every((body) => body.conversation_id === null));
    assert.equal(
      new Set(mock.conversationBodies.map((body) => body.parent_message_id)).size,
      mock.conversationBodies.length
    );
  } finally {
    mock.restore();
  }
});

test("image continuation cannot switch between normal and Custom GPT conversations", async () => {
  __resetChatGptWebCachesForTesting();
  const imageId = storeChatGptImage(Buffer.from([1, 2, 3]), "image/png", 30_000, {
    conversationId: "conversation-first-gpt",
    parentMessageId: "message-first-gpt",
    customGptId: "g-First123",
  });
  const mock = installMockTransport();
  try {
    const result = await execute({
      custom_gpt_id: "g-Second456",
      messages: [
        {
          role: "assistant",
          content: `![image](http://localhost/v1/chatgpt-web/image/${imageId})`,
        },
        { role: "user", content: "make it nighttime with softer lighting" },
      ],
    });
    assert.equal(result.response.status, 409);
    assert.equal((await result.response.json()).error.code, "CUSTOM_GPT_CONVERSATION_MISMATCH");
    assert.equal(mock.conversationBodies.length, 0);
  } finally {
    mock.restore();
  }
});

test("Custom GPT identifiers are redacted from stored request logs", () => {
  assert.deepEqual(
    protectPayloadForLog({
      custom_gpt_id: "g-Private123",
      custom_gpt_url: "https://chatgpt.com/g/g-Private123/private",
      conversation_mode: { kind: "gizmo_interaction", gizmo_id: "g-Private123" },
    }),
    {
      custom_gpt_id: "[REDACTED]",
      custom_gpt_url: "[REDACTED]",
      conversation_mode: { kind: "gizmo_interaction", gizmo_id: "[REDACTED]" },
    }
  );
});

test("executor uploads n8n image input before dispatching the Custom GPT conversation", async () => {
  __resetChatGptWebCachesForTesting();
  const mock = installMockTransport();
  try {
    const result = await execute(
      {
        custom_gpt_id: "g-First123",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              { type: "image_url", image_url: { url: pngDataUrl() } },
            ],
          },
        ],
      },
      { stream: true }
    );
    assert.equal(result.response.status, 200);
    assert.match(await result.response.text(), /data: \[DONE\]/);
    const relevantPaths = mock.requestUrls
      .filter((url) =>
        /conversation\/prepare|backend-api\/files|custom-gpt-upload|f\/conversation$/.test(url)
      )
      .map((url) => new URL(url).pathname);
    assert.deepEqual(relevantPaths, [
      "/backend-api/f/conversation/prepare",
      "/backend-api/files",
      "/files/custom-gpt-upload/raw",
      "/backend-api/files/process_upload_stream",
      "/backend-api/f/conversation",
    ]);
    const upstream = mock.conversationBodies[0];
    const user = (upstream.messages as Array<Record<string, unknown>>).find(
      (message) => (message.author as { role?: string }).role === "user"
    );
    assert.ok(user);
    assert.equal((user.content as { content_type?: string }).content_type, "multimodal_text");
    assert.match(JSON.stringify(user.content), /sediment:\/\/file_customgpt123456/);
    assert.equal(mock.conversationHeaders[0]["x-conduit-token"], "conduit-test");
  } finally {
    mock.restore();
  }
});
