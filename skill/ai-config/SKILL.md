---
name: ai-config
description: Read and validate the local AI Config Manager OpenAI configuration without revealing its API key. Use for integrating tools with ~/.config/ai.yml or diagnosing its encryption and recent changes.
---

# AI configuration

Use the installed `ai-config` binary built by this project. It shares the desktop application's Rust core, YAML rules, encryption envelope and OS vault. Never read the YAML directly into model context: legacy files may contain a plaintext API key.

## Operations

- `ai-config read`: JSON metadata only, including `exists`, `base_url`, `model`, `key_present`, `encrypted` and optimistic `revision`.
- `ai-config check`: validate and decrypt internally; returns only `{ "valid": true }`. It performs no network request and does not establish that the upstream accepts the key or model.
- `ai-config history`: last ten masked change records.
- Append `--config PATH` to use an explicitly selected configuration. The default is `~/.config/ai.yml` even on Windows, where `~` is the user profile directory.

Success is `{ "ok": true, "data": ... }` with exit code 0; failure is `{ "ok": false, "error": { "code": "...", "message": "..." } }` with exit code 1. See the repository README for the current error contract and build/install instructions.

## Secret handling and integration

Never ask the user to paste the API key into a conversation. Never print the file, ciphertext, decrypted key, request Authorization header or OS-vault entry. Do not pass keys on command lines or upload them to diagnostics. The CLI intentionally has no `--show-key` or secret export operation.

For actual model use, integrate the `ai-config-core` Rust library inside the trusted local process and consume the in-memory secret through its scoped configuration API. Keep the key inside that process and send it only to the endpoint the user has authorized. `check` does not authorize an external request. The endpoint is user-configurable and may be a third-party service.

If a key cannot decrypt or the vault is locked/unavailable, stop that operation and surface the error code. Do not rewrite the file, create a replacement vault key, downgrade encryption or fall back to a different configuration. The GUI can replace a lost key only after the user supplies a new key.

The CLI does not rewrite the YAML configuration. Reads may create a private lock file; history queries can finalize an already-committed pending history journal. A successful history query does not validate the YAML; use check separately. Use the desktop UI for changes and plaintext/encrypted storage confirmation. Query operations are repeatable; a configuration read is a snapshot, not a reservation. Backend writes use optimistic revisions and a bounded filesystem lock.
