# WhatsApp Chat Plugin

Bridges Meta WhatsApp Cloud webhooks to a Fusion AI session so you can chat with your configured Fusion assistant from WhatsApp.

## Settings

- `verifyToken`: Webhook verify token configured in Meta app settings.
- `appSecret`: Meta app secret used for `x-hub-signature-256` validation.
- `accessToken`: WhatsApp Cloud API token used to send replies.
- `phoneNumberId`: WhatsApp phone number ID used for Graph API sends.
- `graphApiVersion`: Graph API version (default `v21.0`).
- `allowedSenders`: Optional allowlist of sender phone numbers.
- `agentSystemPrompt`: Optional system prompt for generated replies.

## Webhook routes

- `GET /api/plugins/fusion-plugin-whatsapp-chat/webhook` verification challenge.
- `POST /api/plugins/fusion-plugin-whatsapp-chat/webhook` signed event ingress.

## Behavior

- Validates Meta signature against raw request body.
- Ignores unsupported/non-text messages.
- Deduplicates inbound WhatsApp message IDs.
- Persists sender transcript history to keep multi-turn continuity.
- Sends reply chunks up to WhatsApp text limits.

## Troubleshooting

- 401 on webhook POST: check `appSecret` and raw-body signature header.
- 403 on webhook GET: verify token mismatch.
- No replies: ensure sender is in `allowedSenders` (or clear allowlist) and `accessToken`/`phoneNumberId` are valid.
