# Security boundaries

The bridge has the MAX bot token and a random gateway credential. It has no
Chatwoot Application API token and cannot reach Rails/PG/Redis/Mailpit networks.
A separate gateway holds the native agent token. Chatwoot agent membership alone
DOES NOT restrict contact API reads; this is why the gateway is required.

Gateway RPC permits only MAX user contact creation, owned conversations/incoming
messages, private failure notes and attachments of PUBLIC outgoing/template
messages. It rejects other contacts/inboxes and raw REST paths, including email
contact read/update. Contacts shared into another inbox fail closed before any
link/write. It returns minimal IDs/content, not raw contact/custom attributes.
The gateway is not a generic proxy and has no external egress. Its broad token
remains a sensitive credential; a compromise of the gateway itself is a separate
trust boundary from a compromise of the bridge.

All Redis keys, queues, receipts and gateway state are bound to public Chatwoot
instance origin/account/inbox/bot. A persistent fingerprint refuses configuration
changes/restored foreign state. Cached conversations are checked against current
contact and inbox ownership before use. Rebinding is explicit and allowed only
for empty state; never flush state to bypass the check after real traffic.

Incoming admission persists payload+quota atomically in Redis before ACK; a pump
recovers interrupted queue insertion. Default quotas: two outstanding and ten
accepted events/minute per sender, global1000. Four incoming workers serialize
per sender with a renewable lease; one user cannot consume all workers. HMAC/MAX
authentication and connection/body/concurrency limits apply. Gateway serializes
upstream side effects with four permits held until execution ends; disconnected
queued work is removed, active work is aborted, and HTTP has a total deadline.

Gateway receipts checkpoint before a native message write; only uncertain retries
scan history, at most three pages down to the saved pre-write message ID. An
insufficient window stops reconciliation rather than creating an unchecked copy.
Normal new messages do not scan full history. Ambiguous MAX outbound ACKs are
parked rather than resent blindly. No exactly-once guarantee is asserted.

All JSON is bounded while streaming before parse, including upload responses.
MAX upload uses HTTPS/host allowlist/public pinned DNS, bounded bytes and no
redirects. SDK types are compile-time only: its unbounded/debug upload runtime is
not shipped. DEBUG and NODE_DEBUG are refused. Exceptions/HTTP bodies/credentials
are not written to logs.

## Retention

Queue maintenance runs on startup and hourly without requiring another completed
job: completed payloads7 days, failed30 days (up to one-hour sweep delay). Unprocessed
admissions expire after30 days with an expired counter; active jobs finish first.
The bridge dedup receipts expire30 days. Gateway receipts contain IDs only, not
payloads. Redis performs independent daily AOF rewrite and RDB refresh, so obsolete
bytes can persist up to another24 hours during compaction. Do not promise secure
physical erasure of historical disk blocks. Chatwoot conversation history follows
its own policy; this policy concerns copies held by the bridge.

Root-only deployment snapshots contain secrets/data. The infrastructure timer
expires RDB/SQLite snapshot payloads AND copied environment secrets7 days after
snapshot creation independently of deployments (hourly sweep); only non-secret
Compose/release metadata are retained. Exact one-off MAX migration snapshots have
the same expiry. The pre-MAX full Chatwoot dump has its own Chatwoot-owned7-day
policy targeting only that named dump, without pruning unrelated backups.
Thus a snapshot can retain older queue content beyond the online retention window.
Central Chatwoot backups have their own infrastructure policy. Off-host production
backup/monitoring is a separate prerequisite; the current stand is not activated.

## Supply chain

Actions are pinned by commit SHA. The image archive is signed with GitHub/Sigstore
provenance. Before docker load the stand checks artifact digest, exact repository,
workflow path, staging source ref, source SHA and hosted-runner identity; a root-owned
allowlist pins the reviewed workflow bytes. Changing that workflow requires an
explicit infrastructure trust update, ordinary source pushes do not. OCI labels
and release checksums are additional integrity hints, not provenance proof.

The deploy key exists only in the staging-bound max-test GitHub environment and
is restricted to a validated commit deployment command on the stand. Branch
protection blocks force/delete and requires CI for non-admin writers. The repository
owner retains normal direct pushes as requested; no new manual review gate is added.
An owner/admin able to deliberately change trusted application source remains
trusted. These controls do not claim to defeat every repository-owner compromise.
