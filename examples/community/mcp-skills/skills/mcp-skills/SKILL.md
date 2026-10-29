---
name: mcp-skills
description: Answer with evidence from the bundled local MCP server.
---

Read the [reference](assets/reference.txt), exposed by the bundled server as
`evidence://reference`. Inspect the MCP catalog, call its `answer` tool, and use
the server's `res_read` resource bridge to read that URI. Cite the reference.
Report connection errors instead of inventing an answer. This skill authorizes
no filesystem writes or external network requests.
