---
title: "Providers - ChatGPT Web"
version: 3.8.50
lastUpdated: 2026-08-04
---

# Providers - ChatGPT Web

## `chatgpt-web`

`chatgpt-web` translates OpenAI Chat Completions requests to ChatGPT's internal web
conversation protocol. It uses an authenticated `chatgpt.com` browser session, not the
official OpenAI API. The executor and its upstream endpoint are defined in
`open-sse/executors/chatgpt-web.ts:36`.

This integration is unofficial. ChatGPT Web endpoints and payloads can change without notice
and may break this provider.

## Authentication Flow

Supply the `__Secure-next-auth.session-token` value, chunked session-token cookies, or a full
Cookie header when configuring the provider. For each request, the executor:

1. Exchanges the cookie at `GET https://chatgpt.com/api/auth/session` and caches the resulting
   access token for up to five minutes (`open-sse/executors/chatgpt-web.ts:255`).
2. Performs the normal ChatGPT browser warm-up and Sentinel chat-requirements flow
   (`open-sse/executors/chatgpt-web.ts:493`).
3. Posts the translated request to `POST https://chatgpt.com/backend-api/f/conversation`.
4. Converts ChatGPT's cumulative SSE events to OpenAI streaming or non-streaming responses
   (`open-sse/executors/chatgpt-web.ts:1623`,
   `open-sse/executors/chatgpt-web.ts:1979`).

Cookies, access tokens, authorization headers, and Custom GPT identifiers are redacted from
stored request logs.

## Custom GPTs

The Chat Completions request accepts either of these optional top-level fields:

| Field            | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `custom_gpt_id`  | A Custom GPT ID such as `g-AbC123xyz`                                  |
| `custom_gpt_url` | An HTTPS `chatgpt.com/g/g-...` URL, with an optional slug/query string |

The normalizer trims whitespace, accepts only an alphanumeric ID after `g-`, and rejects
non-HTTPS URLs, arbitrary domains, credentials, ports, or unrelated ChatGPT paths
(`open-sse/executors/chatgpt-web/customGpt.ts:30`). `www.chatgpt.com` is also accepted. Current
links that append the slug in the same path segment, such as `g-<32 hex characters>-my-gpt`, are
normalized to the 32-character GPT ID.

When both fields are present, they must resolve to the same ID. Otherwise OmniRoute returns
`INVALID_CUSTOM_GPT_ID`; neither field silently overrides the other. Requests without either
field retain the existing primary-assistant behavior.

For a valid Custom GPT, OmniRoute sends the browser protocol mode on every upstream request:

```json
{
  "conversation_mode": {
    "kind": "gizmo_interaction",
    "gizmo_id": "g-AbC123xyz"
  }
}
```

This mode is selected per request in `open-sse/executors/chatgpt-web.ts:1035`. No mutable global
Custom GPT selection is used.

### ID Example

```json
{
  "model": "chatgpt-web/gpt-5.3-instant",
  "custom_gpt_id": "g-AbC123xyz",
  "messages": [
    {
      "role": "user",
      "content": "Generate the scene prompt."
    }
  ],
  "stream": false
}
```

### URL Example

```json
{
  "model": "chatgpt-web/gpt-5.3-instant",
  "custom_gpt_url": "https://chatgpt.com/g/g-AbC123xyz/my-gpt",
  "messages": [
    {
      "role": "user",
      "content": "Generate the scene prompt."
    }
  ],
  "stream": true
}
```

The Custom GPT is a conversation configuration, not a model. Continue to select one of the
models exposed by `chatgpt-web`; do not put the `g-...` ID in `model`.

## Image Input

ChatGPT Web accepts PNG and JPEG input images in the OpenAI Chat Completions `image_url` format.
This is the shape emitted by n8n when its OpenAI-compatible model input contains binary image
data:

```json
{
  "model": "chatgpt-web/gpt-5.6-thinking",
  "custom_gpt_id": "g-AbC123xyz",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Describe this image."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgo..."
          }
        }
      ]
    }
  ],
  "stream": false
}
```

Only Base64 data URLs are accepted. Remote HTTP(S) image URLs and SVG are rejected. Limits are
four images, 10 MiB per image, 20 MiB decoded in aggregate, 16,384 pixels per dimension, and 100
megapixels. MIME type, Base64 encoding, magic bytes, and dimensions are validated before any
authenticated upstream request. Only images in the newest user turn are uploaded; replayed
historical image parts are not uploaded again.

For each request, OmniRoute follows the browser flow captured from ChatGPT Web:

1. Prepare the turn at `POST /backend-api/f/conversation/prepare`.
2. Allocate each attachment at `POST /backend-api/files`.
3. Upload raw bytes to the returned HTTPS `*.oaiusercontent.com/.../raw` URL.
4. Process the attachment at `POST /backend-api/files/process_upload_stream`.
5. Submit a `multimodal_text` message containing a `sediment://file_...` pointer.

The signed upload request never receives the ChatGPT Cookie, Bearer token, account ID, device ID,
Sentinel token, or conduit token. Redirects are disabled, and the signed URL host/path is validated
before upload. Image bytes, signed URLs, and conduit tokens are not included in stored request
logs. The implementation is in `open-sse/executors/chatgpt-web/uploads.ts`.

## Conversation Continuity

Text chat is stateless at the native ChatGPT-conversation level. OpenAI-compatible clients
normally resend their message history, so OmniRoute starts a fresh temporary upstream
conversation for each API request and folds prior turns into the prompt
(`open-sse/executors/chatgpt-web.ts:149`). The requested Custom GPT mode is applied to every
fresh conversation. Clients should resend `custom_gpt_id` or `custom_gpt_url` with every turn.

Client-supplied ChatGPT `conversation_id` and `parent_message_id` values are not supported for
text continuation and are not exposed in the OpenAI response.

Generated-image edits are the exception: OmniRoute keeps short-lived native conversation state
with the cached image. That state records the associated Custom GPT
(`open-sse/services/chatgptImageCache.ts:49`). Continuing the image conversation without that GPT
or with another GPT returns `CUSTOM_GPT_CONVERSATION_MISMATCH` instead of switching it.

## Access and Capabilities

The authenticated ChatGPT account must be allowed to open the GPT. The wire payload is the same
for a GPT owned by the account, a public GPT, a private GPT, or a GPT shared by link; actual
availability remains an upstream account/access decision.

The ChatGPT frontend can load GPT metadata before rendering its UI, but no metadata-derived token
is required by the conversation payload implemented here. OmniRoute therefore sends the GPT ID
directly and does not add an extra metadata lookup.

Custom instructions should apply because the conversation is created in `gizmo_interaction`
mode. The image upload wire format was verified from a real browser capture and is covered by
protocol-level automated tests, but still needs end-to-end validation against the operator's own
authenticated session because these private endpoints can change. Actions, Knowledge files, and
every GPT-specific tool have not been validated end to end. Their availability depends on what
the private ChatGPT Web protocol enables for the authenticated account. OmniRoute's OpenAI
`tools` support for this provider remains prompt emulation and is separate from native Custom GPT
tools.

## Errors

| HTTP | Code                               | Meaning                                                         |
| ---- | ---------------------------------- | --------------------------------------------------------------- |
| 400  | `INVALID_CUSTOM_GPT_ID`            | The ID/URL is malformed, or both fields identify different GPTs |
| 401  | `CHATGPT_WEB_SESSION_EXPIRED`      | The configured ChatGPT Web session is absent or expired         |
| 404  | `CUSTOM_GPT_NOT_ACCESSIBLE`        | The requested GPT does not exist or is not accessible           |
| 409  | `CUSTOM_GPT_CONVERSATION_MISMATCH` | A persisted image conversation belongs to another GPT           |
| 400  | `INVALID_CHATGPT_WEB_IMAGE`        | Image input is malformed, unsupported, or exceeds count limits  |
| 413  | `CHATGPT_WEB_IMAGE_TOO_LARGE`      | One image or the aggregate decoded input exceeds byte limits    |
| 502  | `CHATGPT_WEB_IMAGE_PREPARE_FAILED` | ChatGPT did not prepare an attachment-enabled conversation      |
| 502  | `CHATGPT_WEB_IMAGE_UPLOAD_FAILED`  | Allocation, transfer, or upstream image processing failed       |

ChatGPT can use privacy-preserving responses for private or deleted GPTs. OmniRoute maps a 404
from a Custom GPT conversation request to `CUSTOM_GPT_NOT_ACCESSIBLE`; it does not expose the raw
upstream body. A 403 can also indicate an expired session or an upstream anti-bot decision and is
therefore treated as a session/authentication error unless Sentinel already classified it.

## curl

```bash
curl --no-buffer http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web/gpt-5.3-instant",
    "custom_gpt_id": "g-AbC123xyz",
    "messages": [
      {"role": "user", "content": "Create an animation prompt for this scene."}
    ],
    "stream": true
  }'
```

For a JSON response, set `stream` to `false` and remove `--no-buffer`.

## n8n

Use an HTTP Request node when the OpenAI node does not expose arbitrary top-level request fields:

- Method: `POST`
- URL: `http://<omniroute-host>:20128/v1/chat/completions`
- Authentication header: `Authorization: Bearer <OmniRoute API key>`
- Content type: JSON
- Body:

```json
{
  "model": "chatgpt-web/gpt-5.3-instant",
  "custom_gpt_id": "g-AbC123xyz",
  "messages": [
    {
      "role": "system",
      "content": "Follow the user's request."
    },
    {
      "role": "user",
      "content": "Create an animation prompt for this scene."
    }
  ],
  "stream": false
}
```

For multiple n8n items or parallel workflow executions, keep the ID in each item's request body.
Do not store the selected GPT in shared workflow state.
