# fusion-plugin-cli-printing-press

Bundled first-party Fusion plugin for generating and managing service CLIs.

## Storage & Config Model

### Tables

- `cli_press_services`: service metadata (`id`, `slug`, `displayName`, `description`, `baseUrl`, `sourceKind`, `sourceRef`, timestamps)
- `cli_press_cli_specs`: generated/spec inputs per service (`id`, `serviceId`, `name`, `version`, `generatorVersion`, `specJson`, `generatedAt`, `status`, `lastGenerationError`, timestamps)
- `cli_press_artifacts`: generated artifact metadata (`id`, `cliSpecId`, `kind`, `path`, `executable`, `checksum`, `sizeBytes`, timestamps)
- `cli_press_credentials`: non-OAuth credentials (`id`, `serviceId`, `name`, `kind`, `value` envelope, `placement`, timestamps)
- `cli_press_service_settings`: service-scoped key/value settings (`id`, `serviceId`, `key`, `value`, `scope`, timestamps)

All IDs are UUIDv4-based with prefixes: `svc_`, `cli_`, `art_`, `cred_`, `set_`. Timestamps are ISO-8601 strings.

### Exported Types

- `Service`: canonical external-service record
- `CliSpec`: persisted cli-printing-press spec/generation state
- `CliArtifact`: artifact file metadata (path stored relative to `<projectRoot>/.fusion/`)
- `Credential`: persisted secret envelope + placement metadata
- `CredentialKind`: closed union of non-OAuth kinds (`api_key`, `bearer_token`, `basic_auth`, `header`, `query_param`, `env_var`)
- `CredentialPlacement`: discriminated placement union
- `ServiceSetting`: service-level setting entry (`runtime` | `wizard` | `metadata`)
- `OAuthNotSupportedError`: thrown when oauth/oauth2 is passed
- `InvalidCredentialPlacementError`: thrown on kind/placement mismatch or invalid `api_key` placement

### Credential placement union

- `{ kind: "header", header: string }`
- `{ kind: "query_param", queryParam: string }`
- `{ kind: "env_var", envVar: string }`
- `{ kind: "bearer_token", header: string }`
- `{ kind: "api_key", header?: string, queryParam?: string }` (exactly one required)
- `{ kind: "basic_auth", header: string }`

### Credential encoding/materialization

- Values are stored as `{ encoding: "base64", value: string }` via `encodeCredentialValue`/`decodeCredentialValue`.
- `applyCredentialToRequest` materializes credentials into `{ headers, query, env }` and rejects OAuth at runtime.

### OAuth policy (deferred)

OAuth/OAuth2 flows are intentionally excluded from v1. Any `oauth`/`oauth2` kind is rejected by store-layer and helper-layer guards with `OAuthNotSupportedError`. Follow-up remains tracked in **FN-3762**.

### Artifact path convention

Generated artifacts are expected under:
`<projectRoot>/.fusion/plugins/cli-printing-press/artifacts/<serviceId>/<specId>/<artifactFile>`

`CliArtifact.path` stores the path relative to `<projectRoot>/.fusion/`.

### Deletions and filesystem cleanup

`deleteService`, `deleteSpec`, and `deleteArtifact` remove DB records. v1 intentionally does **not** remove artifact files from disk; cleanup is deferred to **FN-3767**.
