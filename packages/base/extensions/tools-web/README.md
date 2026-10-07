# web_fetch

Reads one public HTTP(S) URL from the Agnes host machine. No API key or search subscription is required. The tool returns HTML as Markdown, or a textual response, with the final URL and HTTP status. It does not search by keywords or execute JavaScript.

```json
{ "url": "https://example.com/article" }
```

The bundled `agnes/tools-web` extension declares `network.publicRead` and `artifacts`. The deployment's `policy.capabilityCeiling` must explicitly admit those capabilities. New local-dev profiles include the grant; an existing managed profile is not silently widened. The standard preset exposes `web_fetch`; custom presets with their own `tools.core` list must include it to advertise it through that list.

Restrictions: anonymous GET, public IP destinations only, no Cookie or authentication headers, same-origin redirects only (at most five), 30-second upper time limit, 2 MiB identity response body, 100,000 decoded code points. Proxy environment variables cause an explicit unsupported error, without bypassing the proxy; compressed responses are unsupported in this version. Cross-origin redirects report the new URL for a separate call, including HTTP→HTTPS and host→www changes.

Model output uses the tool output guard (preset `tools.output_max_bytes`, default 32 KiB) and artifact storage. A stored result may itself be partial when the download/decoding limit was hit; this is reported explicitly. A cut result names the stored text by an `artifact://…` path that `read` and `grep` accept; this tool has no pagination of its own. Non-2xx responses are labeled with their actual status; an error page is not treated as the requested article. URL arguments are recorded by the existing tool ledger: do not put credentials or secrets in URLs.

The feature does not change ordinary extension `net.fetch`, model endpoints, MCP transports, or shell networking. It is a checked tool channel, not an OS-level network sandbox. Existing sessions/processes need their usual reload/restart before new bundled code is available.

Parts of the address policy and HTML-depth guard are adapted from DeepSeek Harness; the source retains the MIT notice, also available in `DEEPSEEK-LICENSE.txt`.

## web_search

`web_search` accepts one to four `queries`. The tool contract is unchanged: it returns titles, URLs and snippets, and `WEB_SEARCH_UNAVAILABLE` when no provider is ready. A deployment can still inject its own `SearchProvider` through `createHost`. Otherwise the official registry reads `search/providers.json` under the profile data directory.

Settings → Web search configures Brave, Tavily, Exa, Perplexity or a self-hosted SearXNG origin, result limit, timeout and request rate. API keys are written only through the credential store at `secret://search/<provider>`, under `<home>/secrets`. That is also the file adapter's default directory. A store left under `<dataDir>/secrets` is moved there. The configuration file rejects key material. Tool calls and the settings test share one per-provider rate window stored next to that file. Each result snippet includes a `Citations` list. Provider failures stay generic and do not log credentials. See [default tools](../../../../docs/reference/default-tools.md).
