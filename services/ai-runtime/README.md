# Jupiter AI runtime

Provider-agnostic SET 3 runtime for dynamic provider registration, model discovery, capability/privacy routing, explicit fallback, streaming chat, cancellation, and durable conversation coordination.

The initial adapter supports configured OpenAI-compatible cloud and loopback endpoints. It does not hardcode provider availability. Credentials are supplied through the `CredentialVault` port implemented by Electron Main with Windows DPAPI; this package never persists or logs credential plaintext.

Tool calls are returned as structured display data only. They are not executed in SET 3. Attachment references are contract-ready, while attachment ingestion remains unavailable until Artifact Manager is implemented.
