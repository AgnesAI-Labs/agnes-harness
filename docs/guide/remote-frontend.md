# Cloud workbench integration preview

English | [简体中文](remote-frontend.zh-CN.md)

[Documentation](../README.md) · [Installation](install.md) · [Plugins](packages.md) · [Credentials](credentials.md)

This guide applies to Harness deployments that provide **Settings → Advanced → Cloud connection**. Obtain matching Harness builds for both ends and the compatible cloud plugin archive from your deployment operator. The integration described here uses Harness Extension API `5.23.0`.

The local workbench (A) serves the browser UI and manages local credentials. The remote Harness (B) owns cloud sessions, workspaces, models, tools and approvals. Only B needs the cloud plugin. The workbench supports one cloud connection at a time.

Settings diagnostics follow the selected local or cloud execution environment. An unreachable cloud reports failure instead of silently exporting local diagnostics; account management stays on A. For credential-discovered cloud connections, offline recovery makes at most eight discovery attempts with a 65-second request timeout and backoff capped at 30 seconds. Credential rejection (including HTTP 401) consumes this budget without granting access. Missing credentials, invalid authorization or exhaustion stop recovery; users can reconnect manually. A changed instance address is reauthorized and the selected session restored without replaying creation, sends or tools. After a confirmed replacement of the selected cloud credential value on A, the workbench reauthorizes and restores the cloud session selection. Credentials remain managed by A; editing another credential or only renaming one does not reconnect. An invalid replacement reports a connection failure and can be corrected before retrying.

Each backend authorization has one 45-second total budget: broker requests allow up to 25 seconds and sandbox authorization up to 15 seconds, capped by the remaining total. Network failures, timeouts and HTTP 502/503/504 share at most one retry after one second across both stages. Invalid responses, credential rejection, stopped sandboxes and rate limits are not retried within that exchange. SDK, parent-frame, child-frame and connection deadlines allow 50, 55, 60 and 65 seconds respectively so an inner request finishes first. Only credential discovery and authorization are retried; business requests are never replayed. Ordinary WebSocket disconnections reuse the current transport credential. Confirmed authentication rejection triggers transport renewal, with failed renewals backing off for 2, 5 and then at most 10 seconds. Successful authorization or a manual reconnect that supplies a new grant clears this cooldown. The original browser capability's expiry and scope remain unchanged.

## Configure the remote Harness

For managed sandboxes, the deployment operator prepares B and provisions the instance before users connect. For a source deployment, follow the [installation guide](install.md) for platform prerequisites. From the root of a compatible source checkout, use the same build command on macOS, Linux and Windows PowerShell.

```sh
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
```

Configure B's service environment before starting its daemon and Workers. Inject the deployment Key through your service's secret configuration. Replace the reserved domain below with your model gateway. For persistent services, put the variable in the service environment. Restart existing daemon and Worker processes through the deployment's normal lifecycle after changing their environment.

macOS and Linux

```sh
export AGH_CLOUD_API_BASE_URL='https://models.example.com/v1'
```

Windows PowerShell

```powershell
$env:AGH_CLOUD_API_BASE_URL = 'https://models.example.com/v1'
```

| Setting | Purpose |
| --- | --- |
| `AGH_CLOUD_KEY` | Deployment Key. The compatible plugin also accepts `AGH_API_KEY`. Supply matching values if both are set. |
| `AGH_CLOUD_API_BASE_URL` | Model gateway base. The compatible plugin also accepts `OPENAI_BASE_URL`. Supply matching values if both are set. |
| `LLMSG_TRACK_URL` | Complete tool usage report URL. When omitted, the plugin uses `/llmsg/api/track/tool_calls` on the model gateway origin. |

The LLMSG entrypoint requires nonempty `AGH_CLOUD_API_BASE_URL` and `LLMSG_TRACK_URL`. On first startup, Core initializes an empty home or one containing only a valid `$AGH_HOME/cloud-key`. The file takes precedence. When it is absent, supply `AGH_CLOUD_KEY` or `AGH_API_KEY`. Both values must agree if set together. The entrypoint creates the private Key file only after plugin installation succeeds and only if the file is still absent. Use an image whose startup script and Harness runtime were built together. The entrypoint refuses old or otherwise unrecognized unmarked homes.

Use an HTTPS model gateway base in deployments. The base accepts HTTP(S) and can include an API path, such as `/v1`. Keep embedded credentials, queries and fragments out of the base. The plugin normalizes the trailing slash, appends `models` for GET and `chat/completions` for OpenAI-compatible POST/SSE, and uses the deployment Key as a bearer credential for both.

**Before exposing B to clients, configure HTTPS/WSS** using B's [publication TLS settings](#publication-and-authorization-api) or an HTTPS ingress that supports WebSocket upgrades. When using an ingress, keep B's backend listener private. Keep the endpoint closed to remote clients during setup and verify HTTPS and WSS from your deployment network before opening it. Limit plain HTTP/WS client connections to isolated tests on a trusted network with test Keys.

Place the operator-supplied plugin archive in the current directory as `agh-cloud-plugin.tgz` or use its actual path. Use the matching installed `agh` CLI in either shell. From a built source checkout, replace `agh` with `mise exec -- node agnes.mjs`. Review the source and capabilities before confirming installation, trust and activation. Run both commands under the same home, profile and service environment.

```sh
agh plugins add "./agh-cloud-plugin.tgz"
agh serve
```

Create a new cloud session after upgrading B and the plugin. Eligible existing sessions can migrate to the current plugin generation through their runtime settings. If the plugin provides an `imageModels` setting, list only model IDs whose image support you have verified with your gateway.

## Connect from the local workbench

1. Start the matching build on A with `agh serve` and open the local URL it prints.
2. Open **Settings → Permissions → Credentials** and create a generic credential using the Key issued for the existing LLMSG sandbox. Keep Keys out of URLs, command history and logs.
3. Open **Settings → Advanced → Cloud connection**. Select the credential and choose **Save and connect**. **Manage local credentials** opens A's credentials page, and **Refresh credentials** reloads the list.
4. Wait for **Ready**, then select **Cloud** below session search and use **+** to start a session. Check that its model and workspace belong to B. Switch to **Local** to return to A's sessions. A's sidebar management links open A's settings. Use B's own workbench to administer B.

The connection screen discovers the sandbox from the selected credential. It has no manual address field. A legacy `?remote=` link selects an explicit backend origin and requires an existing credential binding for that exact origin in the same browser. A direct service origin looks like `https://harness.example.com:8443`. A fresh browser should use the credential discovery flow on a deployment that supports it. Keep Keys and temporary capabilities out of the link.

To use a deployment-specific discovery broker, set `AGH_LLMSG_API_BASE_URL` in **A's daemon environment** to the operator-provided HTTPS origin, such as `https://broker.example.com`. Give the scheme, host and optional port. Restart A's daemon to apply changes. This setting is independent of B's model gateway base. An explicit override remains authoritative when it is invalid or unreachable.

A's daemon sends `POST /llmsg/api/agh/connection` with body `{}` and the managed LLMSG Key as a bearer credential. The broker discovers an existing sandbox and returns its bound HTTPS origin and a platform traffic token. A keeps this token in its daemon and launcher and uses it to relay authorized sandbox traffic. A rejected Key needs credential correction. HTTP 409 means the sandbox is unavailable. For HTTP 429, wait for the rate limit to clear before reconnecting.

The workbench address retains the local page or settings section and the workspace selected for a local draft or named by a Skills link. Reload restores that destination. Browser Back and Forward revisit the local destination or cloud conversation in the address. Reloading a new cloud conversation returns to its draft view. Returning to Local restores the page you left, including after reloading while Cloud is selected. Reconnecting to the same cloud deployment restores its selected conversation.

Disconnecting clears the active connection while preserving the stored credential. Local sessions remain available during cloud interruption. Browser private-network, mixed-content and certificate rules apply. Use a compatible secure endpoint for HTTPS pages.

## Publication and authorization API

A trusted, enabled plugin on B declares the profile query `frontend.publish` in its client descriptor. It accepts `{}`. The result has the following shape. Use the lowercase, 64-character SHA-256 digest of the deployment Key as the verifier.

```json
{
  "enabled": true,
  "access": "key-owner",
  "host": "0.0.0.0",
  "port": 8443,
  "auth": { "keySha256": "<64 lowercase hexadecimal characters>" }
}
```

`host` is the listener bind address. Clients use the reachable hostname of the HTTPS endpoint. For TLS on B, set both `tls.certFile` and `tls.keyFile` to B's certificate and private key files. Without those fields the publication listener uses HTTP/WS. B's local Web interface has a separate listener.

- The browser sends the credential reference to A's same-origin `POST /_agnes/cloud-connection/authorize`, with the backend origin when supplied. A's daemon resolves the Key and exchanges it with B via `POST /_agnes/remote-frontend/auth` with `{key}`.
- B returns an eight-hour capability for metadata, HTTP APIs, plugin assets and WebSocket upgrades under `/_agnes/remote-access/<capability>/…`. Within that prefix, B serves protected metadata at `/_agnes/remote-frontend` and WebSocket upgrades at `/_agnes/remote-frontend/ws`. Keep full capability URLs out of logs and examples.
- Direct connections use B's HTTP/WebSocket listener. LLMSG uses A's isolated relay, keeping the platform traffic token in A's backend. Cloud browser streams require matching builds on both ends to preserve `x-agnes-stream-open: 1` alongside ordinary authentication.
- `key-owner` gives the holder full workbench authority over B's profile. Tool approvals still apply. Use separate deployments when users need distinct identities or tenant isolation. Disabling the publishing plugin or closing its launcher stops publication.

## Tool usage reporting

For deployments with usage reporting enabled, deploy the matching Core and cloud plugin together. The plugin sends `POST` to the reporting URL with the model gateway bearer credential. The body contains `request_id` from the `X-Oneapi-Request-Id` model response header and `tool_calls`, a map of tool names to counts.

Only successful calls on the cloud model route count. The matching plugin uses trusted Core dispatch evidence, deduplicates internal retries and counts deferred tools after their final successful result. A report waits for pending outcomes so it can send complete counts for the request. Retries of transient delivery failures retain the original request ID and counts. `cloudusage.check` exposes queued, blocked and sent counts. Persist plugin state across restarts to retain pending reports.
