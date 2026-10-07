# __PACKAGE_NAME__

AGH mcp-skills starter. Requires Node.js 24.10 or later and matching AGH package builds.

```sh
npm install
npm run build
npm test
```

The AGH packages in this preview are not yet on npm. Until distribution is available, supply local package artifacts or links through their public package names; keep application imports unchanged.

main contributes the packaged Skill through the skills service. The package also exports mcpServer and includes mcp.json; it does not install or start an MCP service. Start your existing MCP server at the configured URL, then explicitly add, review, trust and enable the definition through AGH MCP management. Install and enable main through plugin management. Keep credentials in secret references, outside this package.
