import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveBrowserContextOptions } from "../../open-sse/services/browserPool.ts";
import { chatGptWebBrowserContextOptions } from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";

// Logged-in chatgpt.com serves `script-src 'nonce-…' 'self' … https://` without `blob:`, so the
// clean-room bridge's injected blob: module failed with "bridge module failed to load" until the
// ChatGPT Web context bypassed the page CSP.
describe("ChatGPT Web page CSP bypass", () => {
  test("pooled contexts keep the page CSP unless a caller opts out", () => {
    const options = resolveBrowserContextOptions({});

    assert.equal("bypassCSP" in options, false);
    assert.equal(options.locale, "en-US");
    assert.equal(options.timezoneId, "America/New_York");
    assert.deepEqual(options.viewport, { width: 1280, height: 800 });
  });

  test("a caller can bypass the page CSP without losing session or proxy options", () => {
    const storageState = { cookies: [], origins: [] };
    const options = resolveBrowserContextOptions(
      { bypassCSP: true, storageState, locale: "pt-BR" },
      { server: "http://proxy.example.com:8080" }
    );

    assert.equal(options.bypassCSP, true);
    assert.equal(options.storageState, storageState);
    assert.equal(options.locale, "pt-BR");
    assert.deepEqual(options.proxy, { server: "http://proxy.example.com:8080" });
  });

  test("the ChatGPT Web clean-room context bypasses the logged-in page CSP", () => {
    const storageState = { cookies: [], origins: [] };
    const options = chatGptWebBrowserContextOptions({
      connectionId: "connection",
      storageState,
      selection: { kind: "free", thinkEnabled: false },
      userAgent: "CleanRoomBrowser/1.0",
    });

    assert.equal(options.bypassCSP, true);
    assert.equal(options.headless, false);
    assert.equal(options.cookieDomain, "chatgpt.com");
    assert.equal(options.storageState, storageState);
    assert.equal(options.userAgent, "CleanRoomBrowser/1.0");
    assert.equal(options.warmupUrl, "https://chatgpt.com/?temporary-chat=true");
  });
});
