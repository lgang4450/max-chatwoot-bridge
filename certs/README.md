# Public trust anchors

Public Russian Trusted CA X.509 certificates used for MAX Bot API TLS.
These files contain public certificates only, not private keys or credentials.
SHA256SUMS pins the reviewed bytes; Docker verifies them before installing.
Certificate issuer/subject/fingerprint can be inspected with openssl x509.
MAX requirement: https://dev.max.ru/docs-api/methods/POST/subscriptions
The system CA bundle is extended; certificate/hostname verification stays on.
