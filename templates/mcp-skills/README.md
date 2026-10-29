# __PACKAGE_NAME__

AGH mcp-skills starter. Requires Node.js 24.10 or later and matching AGH package builds.

__SETUP_GUIDE__

Use `@agnes/host/author-testkit` for author tests. See the [SDK import map](https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/extend/imports.md) for helpers, contracts and service kind tokens.

main contributes the packaged Skill through the skills service. The package also exports mcpServer and includes mcp.json; it does not install or start an MCP service. Start your existing MCP server at the configured URL, then explicitly add, review, trust and enable the definition through AGH MCP management. After main activates, its Skill is available to new sessions. Keep credentials in secret references, outside this package.
