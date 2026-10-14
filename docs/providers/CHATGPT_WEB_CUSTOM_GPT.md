---
title: "Providers — ChatGPT Web Custom GPTs"
version: 3.8.51
lastUpdated: 2026-10-14
---

# Providers — ChatGPT Web Custom GPTs

The `chatgpt-web` provider (the clean-room browser transport) can run a turn inside a
Custom GPT instead of the primary ChatGPT assistant. The selection is a per-request
extension of the OpenAI Chat Completions body; no global or per-connection GPT state
exists.

## Request fields

| Field            | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `custom_gpt_id`  | A Custom GPT ID such as `g-AbC123xyz`                                  |
| `custom_gpt_url` | An HTTPS `chatgpt.com/g/g-...` URL, with an optional slug/query string |

`normalizeCustomGptId()` (`open-sse/utils/chatgptWebCustomGpt.ts:48`) trims whitespace,
accepts only an alphanumeric ID after `g-`, and rejects non-HTTPS URLs, other hosts,
ports, credentials, and unrelated ChatGPT paths. `www.chatgpt.com` is accepted. Share
links that fuse the slug into the ID segment (`g-<32 hex characters>-my-gpt`) are
normalized to the 32-character ID.

When both fields are present they must resolve to the same ID
(`open-sse/utils/chatgptWebCustomGpt.ts:80`); neither silently overrides the other.
Requests without either field keep the primary assistant.

The Custom GPT is a conversation setting, not a model: keep selecting one of the
`chatgpt-web` models and never put the `g-...` ID in `model`.

## Wire behavior

For a valid GPT, the conversation request built in the logged-in ChatGPT page carries
(`open-sse/utils/chatgptWebFirstParty.ts:864`):

```json
{
  "conversation_mode": {
    "kind": "gizmo_interaction",
    "gizmo_id": "g-AbC123xyz"
  }
}
```

Every API request starts a fresh temporary conversation and folds the resent message
history into the prompt, so clients must send the GPT field on every turn.

## Image input

Images use the provider's standard attachment flow (`open-sse/utils/chatgptWebAttachments.ts`):
OpenAI `image_url` parts with a Base64 data URL or a public image URL, PNG/JPEG/GIF/WebP,
up to 10 attachments per request and 20 MiB per image. Image parts anywhere in the
resent history are uploaded again on each request and count toward the 10-attachment
limit.

```json
{
  "model": "chatgpt-web/gpt-5-6-thinking",
  "custom_gpt_id": "g-AbC123xyz",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this image." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
      ]
    }
  ],
  "stream": false
}
```

## Errors

| HTTP | `error.code`                | Meaning                                                         |
| ---- | --------------------------- | --------------------------------------------------------------- |
| 400  | `INVALID_CUSTOM_GPT_ID`     | The ID/URL is malformed, or both fields identify different GPTs |
| 400  | `CUSTOM_GPT_NOT_ACCESSIBLE` | ChatGPT answered 404: the GPT does not exist or is not shared   |

ChatGPT reports a private, deleted, or unshared GPT as a 404 on the conversation request.
OmniRoute surfaces it as a 400 (`open-sse/utils/chatgptWebExecutorAdapter.ts:485`) because a
404 would put the whole ChatGPT Web connection into the not-found cooldown and block
unrelated requests on the same account. Neither error silently switches the turn to the
primary assistant.

`custom_gpt_id`, `custom_gpt_url`, and `gizmo_id` are redacted from stored request logs
(`src/lib/logPayloads.ts:44`).

## Example

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web/gpt-5-6",
    "custom_gpt_url": "https://chatgpt.com/g/g-AbC123xyz/my-gpt",
    "messages": [{"role": "user", "content": "Create an animation prompt for this scene."}],
    "stream": false
  }'
```

In n8n, use an HTTP Request node when the OpenAI node cannot send arbitrary top-level
fields, and keep the GPT field in each item's body.

## Limits of the transport

- The provider drives a headed Chromium. On a host without `DISPLAY`, the browser pool
  starts a private Xvfb (`open-sse/services/virtualDisplay.ts:86`); the Docker
  `runner-web` target installs Chromium and `xvfb`.
- `tools` and tool messages are rejected; the provider advertises `toolCalling: false`.
- Streaming responses are emitted after the turn completes.
- Actions, Knowledge files, and other GPT-specific tools depend on what ChatGPT enables
  for the authenticated account and have not been validated end to end.
