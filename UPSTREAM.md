# Provenance

Fork of https://github.com/HoroshoVse/max-chatwoot-middleware at
8cc7155b768ec1e300b90391b2f1e6cc6b7172df (25 August 2026).
The upstream package.json declares the SPDX license ISC. Its Git history and
that declaration are preserved; the LICENSE file spells out ISC with attribution
using the upstream GitHub handle.

Fork changes: authenticated webhooks, delivery reconciliation, bounded media,
canonical contact inbox mapping, isolated persistent queue, dependency/image
pins, CI, deployment and recovery documentation. Runtime implementation was
reworked; generated JS/maps/declarations no longer live in src.

The official @maxhub/max-bot-api SDK is MIT licensed; its declarations are used only during compilation. The SDK runtime is no longer
shipped or executed; bounded HTTP/upload replaces its debug and stream transport. Other dependencies retain their notices.
