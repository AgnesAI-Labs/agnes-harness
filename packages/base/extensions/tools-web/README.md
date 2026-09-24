# web_fetch

Reads one public HTTP(S) URL from the Agnes host machine. No API key or search subscription is required. The tool returns HTML as Markdown, or a textual response, with the final URL and HTTP status. It does not search by keywords or execute JavaScript.

```json
{ "url": "https://example.com/article" }
```

The bundled `agnes/tools-web` extension declares `network.publicRead` and `artifacts`. The deployment's `policy.capabilityCeiling` must explicitly admit those capabilities. New local-dev profiles include the grant; an existing managed profile is not silently widened. The standard preset exposes `web_fetch`; custom presets with their own `tools.core` list must include it to advertise it through that list.

Restrictions: anonymous GET, public IP destinations only, no Cookie or authentication headers, same-origin redirects only (at most five), 30-second upper time limit, 2 MiB identity response body, 100,000 decoded code points. Proxy environment variables cause an explicit unsupported error, without bypassing the proxy; compressed responses are unsupported in this version. Cross-origin redirects report the new URL for a separate call, including HTTP→HTTPS and host→www changes.

Model output uses the existing 8 KiB text guard and artifact storage. A stored result may itself be partial when the download/decoding limit was hit; this is reported explicitly. This tool does not provide artifact pagination. Non-2xx responses are labeled with their actual status; an error page is not treated as the requested article. URL arguments are recorded by the existing tool ledger: do not put credentials or secrets in URLs.

The feature does not change ordinary extension `net.fetch`, model endpoints, MCP transports, or shell networking. It is a checked tool channel, not an OS-level network sandbox. Existing sessions/processes need their usual reload/restart before new bundled code is available.

Parts of the address policy and HTML-depth guard are adapted from DeepSeek Harness; the source retains the MIT notice, also available in `DEEPSEEK-LICENSE.txt`.
