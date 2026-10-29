# Manage generic credentials

English | [简体中文](credentials.zh-CN.md)

[Documentation](../README.md) · [MCP](mcp.md) · [Security](security.md)

Generic credentials let a local administrator save an API key or token once and use its reference in MCP, plugin configuration, or webhook rules. The backend, SDK and Web credential editor support this workflow.

## Create and use a credential

Use the authenticated local administrator SDK connection. The ordinary browser chat connection cannot call these methods. Pass the key obtained from your service as `suppliedKey`; keep it out of source code and logs:

```ts
const credential = await client.credentials.create({
  label: 'Business service',
  value: suppliedKey,
})
// Persist credential.id in configuration, never suppliedKey.
const secretBinding = {
  kind: 'http-bearer',
  credentialRef: credential.id,
}
```

The daemon generates an immutable `secret://generic/<UUID>` id. MCP uses this in `secretBinding.credentialRef` or the existing `stdio-env` binding. Plugin secret fields and trigger `secretRef` use the same reference unchanged. Changing the label leaves every reference valid. Rotating the value takes effect when the consuming service next resolves the reference; an existing connection may need reconnecting.

## Manage credentials in the Web UI

Open **Settings → Permissions → Credentials**. The list shows each name, API-key type, creation date, and the configurations using it. Choose **New credential**, enter a name and secret value, then save. The value starts masked, can be shown while entering it, and is cleared after saving; saved values cannot be retrieved.

The row menu offers rename, replace value, and delete. Renaming keeps the reference unchanged. Replacement may require reconnecting MCP services. Deletion shows the using configurations and is refused while referenced. Remove those references first, or explicitly acknowledge that the configurations will stop working and choose **Delete anyway**.

The MCP add and edit dialog also offers **New credential** beside its saved-credential picker. Saving selects the new credential and preserves the connection draft. Generic credentials are also available in plugin secret-field and trigger credential pickers, alongside existing references. Read-only recovery, insufficient permissions, and an unavailable credential store show an explanation in the page or dialog.

## Public contract

| SDK method | App Server method suffix after `_agnes/v1/admin.credentials.` | Input | Result |
| --- | --- | --- | --- |
| `credentials.list()` | `list` | `{}` | `{ items: CredentialMetadata[] }` |
| `credentials.create(input)` | `create` | `{ label, value }` | `CredentialMetadata` |
| `credentials.set(input)` | `set` | `{ id, value }` | `CredentialMetadata` |
| `credentials.rename(input)` | `rename` | `{ id, label }` | `CredentialMetadata` |
| `credentials.delete(input)` | `delete` | `{ id, force?, confirm? }` | `{}` |

`CredentialMetadata` contains only `id`, `label`, `kind: "api-key"`, `createdAt` (UTC ISO timestamp), and `references`. Each reference identifies `{ kind, profile, configId }`, where kind is `mcp`, `plugin`, `trigger`, or `profile`. Lists manage the generic namespace; model accounts and OAuth credentials retain their existing account/login interfaces. Existing manually saved and provider credentials still use their existing secret references.

Labels contain 1–128 characters, values 1–65,536 characters; control characters are rejected. Values are write-only. No method returns a value, value digest, or request body. Unknown fields, including a caller-supplied actor, are rejected.

Read operations require `credentials.read` and the existing `packages.read` local admin grant. Mutations require `credentials.write` and `packages.activate`. Scoped, non-local, and ordinary chat connections are refused. The Web management bridge exposes `GET /admin/api/credentials` and `POST /admin/api/credentials/{create,set,rename,delete}` with the same shapes and origin checks. It forwards through the launcher's private local SDK connection. Writes are refused in control-plane read-only recovery mode.

Failures use the standard App Server error envelope. Fixed cause codes include `CONFIG_CREDENTIAL_REFERENCED`, `CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED`, `CONFIG_CREDENTIAL_NOT_FOUND`, `CONFIG_CREDENTIAL_UNAVAILABLE`, `CONFIG_CREDENTIAL_READ_ONLY`, and `CONFIG_CREDENTIAL_STORE`. Permission refusals use `CAPABILITY_DENIED`; malformed input uses `INVALID_PARAMS`. Values never appear in error detail.

## Rotation and deletion

`set` replaces the complete secret atomically; concurrent updates use last-writer-wins, with no revision or CAS parameter. The daemon serializes credential operations to preserve the label and creation time during rotation. A failed update leaves the existing value usable unless the underlying durable write reports an uncertain failure after replacement.

Deletion is refused while saved MCP definitions, trigger rules, profiles, or plugin configurations still reference the id. Disabled configurations, pending MCP operations, saved plugin values, and retained rollback targets also count. Remove their references first. To explicitly accept breaking those configurations, send both `force: true` and `confirm: true`, following the explicit confirmation pattern used by other admin mutations. A force flag alone is refused. Force deletion leaves the configurations in place; subsequent resolution fails closed. Reference inspection failures refuse deletion even with confirmation.

## Storage and diagnostics

The existing credential store owns these values. It stores private API-key JSON envelopes under the existing home secrets directory, using POSIX owner checks, directories `0700`, files `0600`, atomic replacement, and fsync; Windows uses the existing native private ACL implementation. There is no additional encryption layer. Generic writes require the active file adapter to use this canonical directory; environment, vault, or custom-path adapters are refused rather than saving an unreachable credential.

The credential audit records action attempts with only the connection actor, id, and action, plus the audit timestamp and event kind. It contains no labels, values, or value hashes. Responses and errors omit values; diagnostics exports retain their existing metadata allowlist and do not export the secret store. Keep secret values out of labels, configuration literals, session prompts, and application logs.

Model account settings distinguish missing configuration, transport/listing failures, unknown verification results and server rejection. Only an authenticated request that receives HTTP 401/403 is reported as a rejected API key; a keyless relay asking for authentication is unconfigured. A failed network check does not remove a saved credential.
