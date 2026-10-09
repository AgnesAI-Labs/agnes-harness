# Webhook-triggered sessions

English | [简体中文](webhooks.zh-CN.md)

[Documentation](../README.md) · [Web settings](web.md) · [Deployment](deployment.md)

Business events can start business agents. Open **Settings → Automation → Triggers** to create a rule, choose an existing workspace, agent preset and bundles, and select a `secret://namespace/name` reference. This form accepts references only. Provision the secret through the configured secret adapter; file secrets require owner-only permissions. Environment references can be entered manually (for example `secret://webhooks/github` resolves to `AGNES_SECRET_WEBHOOKS_GITHUB` with the environment adapter).

The endpoint is **off by default**. Save an explicit path such as `/hooks/events`, a payload byte ceiling (default 256 KiB, maximum 1 MiB), and enable the endpoint. The HTTP listener belongs to `serve` and forwards to the shared daemon. Keep both running. Rules and receipts persist in the daemon data directory.

## Rules and prompts

Rules match the provider event type and all field matches, choosing the first matching rule in ascending rule-id order. Supported field paths are `$.issue.title`, `$.repository.full_name` and array indexes such as `$.commits[0].message`; evaluation, wildcards and recursive descent are unsupported. Field-match values use exact JSON equality.

The public `@agnes/extension-api` contract exposes `WebhookTriggerProvider` and `webhookTriggerKind` (`webhook-trigger`, process scope). Official GitHub and generic implementations verify raw bytes and resolve only secret references; rules and session admission remain daemon-owned. The local `_agnes/v1/admin.triggers` method manages rules, endpoint configuration and sample deliveries. The browser uses the same-origin `/api/triggers` adapter.

A filter can be `{"$.action":"opened","$.repository.full_name":"example/business"}`. A template can be `Review this issue: {{$.issue.title}}`. Each selected value is JSON encoded inside a dynamically sized `UNTRUSTED` Markdown fence. External payload text never changes permissions. Expanded prompts are limited to 64 KiB.

Every accepted delivery creates a normal root session using the selected workspace, preset and bundles. Its durable key starts with `agnes:webhook:RULE_ID:` and its prompt identifies the trigger. Workspace ownership, plugin trust, tool policy and approval paths remain the normal session paths. The trigger grants no extra permissions. Recent deliveries show the outcome and a session link. The test button signs the sample server-side and uses the production verifier; a successful test creates a real session.

## Authentication and replay

**GitHub:** configure the webhook's JSON payload and shared secret. AGH verifies `X-Hub-Signature-256` using HMAC SHA-256 over the exact raw body. `X-GitHub-Event` selects the event and `X-GitHub-Delivery` supplies its id. GitHub does **not** sign a timestamp header, so configure a timestamp field in the signed payload: `$.issue.updated_at`, `$.pull_request.updated_at`, or `$.head_commit.timestamp`. Events without a suitable timestamp (including ordinary ping payloads) are rejected by the replay window. A trusted ingress that envelopes such events can use the generic provider instead. Re-deliveries of old events outside the window are refused.

**Generic HMAC:** send `X-Webhook-Id`, `X-Webhook-Event`, `X-Webhook-Timestamp` (Unix seconds), and `X-Webhook-Signature: sha256=HEX`. The signature input is the UTF-8 prefix `TIMESTAMP\nDELIVERY_ID\nEVENT\n` followed by the exact raw JSON body. The timestamp, id and event are authenticated together. Duplicate security headers are refused.

**Generic bearer:** send `Authorization: Bearer TOKEN`, `X-Webhook-Id` and `X-Webhook-Event`; choose a timestamp field in the authenticated payload. The body timestamp is an ISO date string or Unix seconds. Use HTTPS at the proxy. Both generic modes resolve authentication material only through the rule's secret reference.

The rule window allows equally bounded clock skew in the past and future (default 300 seconds, maximum one day). Delivery ids persist for at least one day and through the authenticated replay window. GitHub additionally deduplicates signed body digests because its delivery id is not signature-covered. Deduplication is bounded to 10,000 entries; a full table refuses new events instead of evicting active replay protection. Rate limits count accepted admissions per rule in a rolling minute and survive restart. The latest 200 receipts contain status, rule and session identifiers, never payloads, signatures or credential values.

GitHub's event header is also outside the signature. Match signed payload fields such as repository identity and event-specific objects, and use separate secret references for independent sources. Up to 128 rules and 64 pending administration/delivery requests are retained; excess delivery requests are refused with `capacity`. Disabling a rule or the endpoint stops new admissions.

Admission reservations are persisted before session creation. A crash can leave an `unknown` outcome; failed or unknown admissions are not automatically retried. Inspect the linked session before manually submitting a new event. This does not promise exactly-once external business effects.

## Tunnel or reverse proxy

Keep the existing loopback Web listener. Publish **only the exact opted-in webhook path**, never `/`, `/api/*`, `/admin/*` or the daemon WebSocket. Terminate TLS and impose a matching request-size limit and connection timeout at the ingress. Preserve the raw request body and security headers. Set the upstream Host to `127.0.0.1:4177` (or the configured local Web port).

For example, an nginx location for a dedicated webhook hostname can contain:

```nginx
location = /hooks/events {
    client_max_body_size 256k;
    proxy_set_header Host 127.0.0.1:4177;
    proxy_pass http://127.0.0.1:4177;
}
location / { return 404; }
```

With a tunnel, apply the same exact-path ingress allowlist and deny all other paths. Endpoint secrecy is not authentication: retain signature or bearer verification. Disabling the endpoint blocks new admissions; it does not cancel sessions already created.

Webhook-rendered input enters through a backend-only enqueue path with the verified provider, rule and delivery identity. It is recorded as `system/untrusted`; signing authenticates delivery, not human instruction authority.
