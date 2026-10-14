import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ChatGptWebExecutor } from "../../open-sse/executors/chatgpt-web.ts";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import {
  PlaywrightChatGptWebBrowserSession,
  runChatGptWebBrowserTurn,
  type ChatGptWebBrowserSession,
  type ChatGptWebBrowserSubmission,
  type ChatGptWebBrowserTurnResult,
} from "../../open-sse/utils/chatgptWebBrowserSession.ts";
import {
  CUSTOM_GPT_NOT_ACCESSIBLE_MESSAGE,
  CustomGptInputError,
  CustomGptNotAccessibleError,
  normalizeCustomGptId,
  resolveCustomGptId,
} from "../../open-sse/utils/chatgptWebCustomGpt.ts";
import {
  executeChatGptWebCleanRoom,
  prepareChatGptWebBrowserRequest,
} from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";
import { executeChatGptWebFirstPartyTurn } from "../../open-sse/utils/chatgptWebFirstParty.ts";
import { protectPayloadForLog } from "../../src/lib/logPayloads.ts";

type SafePost = (path: string, options: Record<string, unknown>) => Promise<unknown>;

const BRIDGE_KEY = "__omnirouteChatGptFirstPartyV1";
const ABORT_KEY = "__omnirouteChatGptAbortV1";
const PAGE_URL = "https://chatgpt.com/?temporary-chat=true";

const turn: ChatGptWebBrowserTurnResult = {
  conversationId: "conversation",
  turnExchangeId: "turn",
  text: "answer",
  status: "finished_successfully",
  endTurn: true,
};

function createDirectPage(): import("playwright").Page {
  return {
    async evaluate(
      pageFunction: (argument: unknown) => unknown | Promise<unknown>,
      argument: unknown
    ) {
      return pageFunction(argument);
    },
  } as unknown as import("playwright").Page;
}

function installFirstPartyBridge(safePost: SafePost): () => void {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const previousBridge = root[BRIDGE_KEY];
  const previousAbortStore = root[ABORT_KEY];
  root[BRIDGE_KEY] = {
    finalizeRequirements: async () => ({}),
    proofManager: { getEnforcementToken: async () => "proof" },
    turnstileManager: { getEnforcementToken: async () => "turnstile" },
    requestClient: { safePost },
    buildSentinelHeaders: () => ({ "OpenAI-Sentinel-Proof-Token": "proof" }),
  };
  return () => {
    if (previousBridge === undefined) delete root[BRIDGE_KEY];
    else root[BRIDGE_KEY] = previousBridge;
    if (previousAbortStore === undefined) delete root[ABORT_KEY];
    else root[ABORT_KEY] = previousAbortStore;
  };
}

function fakeSession(): ChatGptWebBrowserSession {
  return {
    url: () => PAGE_URL,
    start: async () => async () => {},
    submitPrompt: async () => "",
  };
}

const credentials = {
  connectionId: "connection",
  providerSpecificData: { storageState: { cookies: [], origins: [] } },
};

function executorInput(body: Record<string, unknown>) {
  return {
    model: "gpt-5-6-instant",
    body: { messages: [{ role: "user", content: "hi" }], ...body },
    stream: false,
    credentials,
  } as unknown as Parameters<ChatGptWebExecutor["execute"]>[0];
}

/** Executors may resolve to a bare Response or to the capture object around one. */
function responseOf(result: Awaited<ReturnType<ChatGptWebExecutor["execute"]>>): Response {
  return result instanceof Response ? result : result.response;
}

describe("ChatGPT Web Custom GPT selection", () => {
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
      "https://user:pass@chatgpt.com/g/g-AbC123/my-gpt",
      "https://chatgpt.com/not-g/g-AbC123",
    ];
    for (const value of invalid) {
      assert.throws(() => normalizeCustomGptId(value), CustomGptInputError, value);
    }
  });

  test("resolveCustomGptId handles absence, matching fields, type errors, and conflicts", () => {
    assert.equal(resolveCustomGptId({}), null);
    assert.equal(resolveCustomGptId(null), null);
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

  test("request preparation carries the GPT only when one is selected", () => {
    const messages = [{ role: "user", content: "hello" }];
    assert.equal(
      "customGptId" in prepareChatGptWebBrowserRequest("gpt-5-6-instant", { messages }),
      false
    );
    assert.equal(
      prepareChatGptWebBrowserRequest("gpt-5-6-instant", {
        messages,
        custom_gpt_id: "g-First123",
      }).customGptId,
      "g-First123"
    );
    assert.equal(
      prepareChatGptWebBrowserRequest("gpt-5-6-instant", {
        messages,
        custom_gpt_url: "https://chatgpt.com/g/g-Second456/my-gpt",
      }).customGptId,
      "g-Second456"
    );
    assert.throws(
      () =>
        prepareChatGptWebBrowserRequest("gpt-5-6-instant", {
          messages,
          custom_gpt_id: "invalid",
        }),
      CustomGptInputError
    );
  });
});

describe("ChatGPT Web Custom GPT conversation mode", () => {
  async function capturedConversationMode(customGptId?: string) {
    let conversationOptions: Record<string, unknown> | null = null;
    const restoreBridge = installFirstPartyBridge(async (path, options) => {
      if (path === "/f/conversation") {
        conversationOptions = options;
        return new Response("data: [DONE]\n\n", { status: 200 });
      }
      throw new Error(`Unexpected first-party path: ${path}`);
    });
    try {
      await executeChatGptWebFirstPartyTurn(createDirectPage(), {
        prompt: "Generate the scene prompt.",
        attachments: [],
        selection: { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 0 },
        ...(customGptId ? { customGptId } : {}),
      });
    } finally {
      restoreBridge();
    }
    const requestBody = conversationOptions?.requestBody as Record<string, unknown>;
    return requestBody.conversation_mode;
  }

  test("keeps the primary assistant without a Custom GPT", async () => {
    assert.deepEqual(await capturedConversationMode(), { kind: "primary_assistant" });
  });

  test("sends gizmo interaction mode for the selected Custom GPT", async () => {
    assert.deepEqual(await capturedConversationMode("g-First123"), {
      kind: "gizmo_interaction",
      gizmo_id: "g-First123",
    });
  });

  test("the browser session forwards the GPT to the first-party request", async () => {
    const observed: unknown[] = [];
    const page = { url: () => PAGE_URL } as unknown as import("playwright").Page;
    const session = new PlaywrightChatGptWebBrowserSession(page, {
      selection: { kind: "free", thinkEnabled: false },
      executePageRequest: async (_page, input) => {
        observed.push(input);
        return "DIRECT_SSE";
      },
    });

    await session.submitPrompt({ prompt: "direct", attachments: [], customGptId: "g-First123" });

    assert.deepEqual(observed, [
      {
        prompt: "direct",
        attachments: [],
        selection: { kind: "free", thinkEnabled: false },
        customGptId: "g-First123",
      },
    ]);
  });

  test("a browser turn forwards the GPT to the session submission", async () => {
    let submitted: ChatGptWebBrowserSubmission | null = null;
    await assert.rejects(
      runChatGptWebBrowserTurn(
        {
          url: () => PAGE_URL,
          start: async () => async () => {},
          submitPrompt: async (request) => {
            submitted = request;
            throw new Error("stop after submission");
          },
        },
        { prompt: "hi", customGptId: "g-First123", timeoutMs: 5_000 }
      ),
      /stop after submission/
    );
    assert.equal(submitted?.customGptId, "g-First123");
  });
});

describe("ChatGPT Web Custom GPT execution", () => {
  test("concurrent requests keep their own GPT selection", async () => {
    const seen: Array<string | null> = [];
    const ids = ["g-Shared123", "g-Other456", null, "g-Shared123"];
    await Promise.all(
      ids.map((id) =>
        executeChatGptWebCleanRoom(
          {
            model: "gpt-5-6-instant",
            body: {
              messages: [{ role: "user", content: `request for ${id ?? "primary"}` }],
              ...(id ? { custom_gpt_id: id } : {}),
            },
            stream: false,
            credentials,
          },
          {
            createSession: async () => fakeSession(),
            runTurn: async (_session, request) => {
              await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
              assert.equal(request.prompt, `request for ${request.customGptId ?? "primary"}`);
              seen.push(request.customGptId ?? null);
              return turn;
            },
          }
        )
      )
    );
    assert.deepEqual([...seen].sort(), [...ids].sort());
  });

  test("maps ChatGPT's 404 for the requested GPT to CustomGptNotAccessibleError", async () => {
    const notFound = new Error("ChatGPT Web conversation failed with status 404 (not_found)");
    const run = (body: Record<string, unknown>) =>
      executeChatGptWebCleanRoom(
        {
          model: "gpt-5-6-instant",
          body: { messages: [{ role: "user", content: "hi" }], ...body },
          stream: false,
          credentials,
        },
        {
          createSession: async () => fakeSession(),
          runTurn: async () => {
            throw notFound;
          },
        }
      );

    await assert.rejects(run({ custom_gpt_id: "g-Missing123" }), CustomGptNotAccessibleError);
    // Without a GPT the upstream failure is not reinterpreted.
    await assert.rejects(run({}), (error: unknown) => error === notFound);
  });

  test("executor rejects invalid and conflicting GPT fields before opening a browser", async () => {
    let sessions = 0;
    const executor = new ChatGptWebExecutor({
      createSession: async () => {
        sessions += 1;
        return fakeSession();
      },
      runTurn: async () => turn,
    });

    for (const body of [
      { custom_gpt_id: "invalid" },
      { custom_gpt_id: "g-First123", custom_gpt_url: "https://chatgpt.com/g/g-Second456/x" },
    ]) {
      const response = responseOf(await executor.execute(executorInput(body)));
      assert.equal(response.status, 400);
      const json = (await response.json()) as { error: Record<string, unknown> };
      assert.equal(json.error.code, "INVALID_CUSTOM_GPT_ID");
      assert.equal(json.error.type, "invalid_request_error");
    }
    assert.equal(sessions, 0);
  });

  test("executor surfaces an inaccessible GPT as a stable 400", async () => {
    const executor = new ChatGptWebExecutor({
      createSession: async () => fakeSession(),
      runTurn: async () => {
        throw new Error("ChatGPT Web conversation failed with status 404");
      },
    });

    const response = responseOf(
      await executor.execute(executorInput({ custom_gpt_id: "g-Missing123" }))
    );

    assert.equal(response.status, 400);
    const json = (await response.json()) as { error: Record<string, unknown> };
    assert.equal(json.error.code, "CUSTOM_GPT_NOT_ACCESSIBLE");
    assert.equal(json.error.message, CUSTOM_GPT_NOT_ACCESSIBLE_MESSAGE);
  });

  test("an inaccessible GPT does not cool down the ChatGPT Web connection", () => {
    const decision = checkFallbackError(
      400,
      CUSTOM_GPT_NOT_ACCESSIBLE_MESSAGE,
      0,
      "gpt-5-6-instant",
      "chatgpt-web",
      null,
      null,
      { code: "CUSTOM_GPT_NOT_ACCESSIBLE", type: "invalid_request_error" }
    );
    assert.equal(decision.cooldownMs, 0);
  });

  test("executor answers a GPT conversation like any other ChatGPT Web turn", async () => {
    let requested: string | null | undefined;
    const executor = new ChatGptWebExecutor({
      createSession: async () => fakeSession(),
      runTurn: async (_session, request) => {
        requested = request.customGptId;
        return turn;
      },
    });

    const response = responseOf(
      await executor.execute(
        executorInput({ custom_gpt_url: "https://chatgpt.com/g/g-First123/my-gpt" })
      )
    );

    assert.equal(response.status, 200);
    assert.equal(requested, "g-First123");
    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(json.choices[0].message.content, "answer");
  });
});

test("Custom GPT identifiers stay out of stored request logs", () => {
  const protectedPayload = protectPayloadForLog({
    model: "chatgpt-web/gpt-5-6-instant",
    custom_gpt_id: "g-Private123",
    custom_gpt_url: "https://chatgpt.com/g/g-Private123/private",
    conversation_mode: { kind: "gizmo_interaction", gizmo_id: "g-Private123" },
  }) as Record<string, unknown>;

  assert.equal(protectedPayload.custom_gpt_id, "[REDACTED]");
  assert.equal(protectedPayload.custom_gpt_url, "[REDACTED]");
  assert.deepEqual(protectedPayload.conversation_mode, {
    kind: "gizmo_interaction",
    gizmo_id: "[REDACTED]",
  });
  assert.equal(JSON.stringify(protectedPayload).includes("g-Private123"), false);
});
