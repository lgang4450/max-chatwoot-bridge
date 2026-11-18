# MAX ↔ Chatwoot Bridge

Webhook bridge for one official MAX support bot and one Chatwoot API inbox.
Fork of [HoroshoVse/max-chatwoot-middleware](https://github.com/HoroshoVse/max-chatwoot-middleware).
ISC license; upstream history/attribution are preserved in [UPSTREAM.md](UPSTREAM.md).

```
MAX message_created → authenticated HTTPS webhook → Redis queue → Chatwoot incoming
Chatwoot public reply → timestamp/body HMAC webhook → Redis queue → MAX Bot API
```

No polling or personal-account sessions. Private dialogs only. Each user is mapped
by `max:<bot_id>:<user_id>`; email/phone/name are not identity proofs and do not
merge accounts. A scoped service agent must be a member of the selected API inbox.

## Delivery behavior

- MAX shared-secret header and native Chatwoot `X-Chatwoot-Signature` HMAC over
  `timestamp.rawBody`, with a five-minute timestamp window; account/inbox/private filters.
- Redis BullMQ: AOF `appendfsync always`, no eviction, one worker per direction,
  six attempts with backoff, queue capacity/backpressure, retained failed jobs.
  MAX SDK API calls are paced to ten requests per second per process, including
  upload URL requests; CDN upload traffic uses the SDK transport.
- Incoming receipts are marked only after Chatwoot delivery. Retries reconcile by
  exact source_id, recovering contacts and canonical contact_inbox source_id.
- Outgoing confirmed receipts suppress duplicates. A definitive 429 is retryable.
  Timeout/crash/ambiguous acknowledgement is parked for operator reconciliation,
  rather than automatically resending a potentially accepted answer. A private
  operator note is attempted on permanent outgoing failure.
- TLS verification stays enabled. Public CA certificates are byte-pinned.
  Media downloads require HTTPS, allowed origins/hosts, public pinned IPv4 DNS,
  bounded redirects, finite timeout and size. Signed Chatwoot ActiveStorage paths
  are fetched from the configured internal Chatwoot service, bypassing staff
  Basic Auth without exposing files publicly. Other internal URL paths are rejected.
  Text/photos/files supported; incoming
  audio/video with direct URLs are forwarded. Outgoing non-image media are uploaded
  as files. Unsupported/token-only MAX media appear as an explicit incoming marker.
- Logs contain controlled event names only, never payloads, credentials, URLs or
  raw exception objects. Webhook payloads/attachments are personal data in storage.

Limits: webhook 64 KiB, MAX reply 4000 UTF-16 code units, ten attachments,
10 MiB per outbound file / aggregate incoming files. Limits deliberately fail
closed. Complete/failed jobs retained 7/30 days (max 1000 each); delivery receipts
30 days. No exactly-once guarantee: a simultaneous failure before persisting a
remote acknowledgement still requires reconciliation. One active replica only.

## Build and verify

Node 24.15+, npm lockfile required:

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=high
```

Set REDIS_TEST_URL to a disposable Redis for the queue reconnect/retry check.
CI runs this integration check with real Redis, builds the image and smoke-tests
prepared mode. Push to `staging` publishes a public prerelease `build-<git-sha>`
with image.tar.gz and SHA256SUMS. The image tag and OCI revision equal that SHA.

## Deploy

See [deployment and recovery](docs/DEPLOYMENT.md). Start with BRIDGE_ENABLED=false:
health reports **prepared**, readiness is **503**, webhooks reject all messages.
This is preparation, not an active MAX integration. Enable only with a moderated
bot, private credentials, a configured API inbox and authenticated HTTPS routes.
