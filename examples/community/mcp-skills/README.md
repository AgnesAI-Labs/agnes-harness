# @community/mcp-skills

A standalone package scaffolded from mcp-skills. Follow the [external author
setup](../README.md) for preview tarballs, build and tests. The package contains a
credential-free local stdio MCP server, one deterministic tool, one text resource,
and a Skill referencing the same packaged asset.

mcp/server.mjs uses the MCP SDK transport. It advertises tools and resources,
implements both catalogs, returns an empty resource-template catalog, and reserves
stdout for protocol messages. answer({question}) returns 42 and the evidence URI
evidence://reference; reading that resource returns
skills/mcp-skills/assets/reference.txt. Invalid calls and unknown resources fail.

## Install and enable

1. Build this package, then inspect/install file:/absolute/path/to/mcp-skills
   through Settings → Plugins. Review and enable @community/mcp-skills.
   Its row injects skills and registers mcp-skills with the plugin lifecycle.
2. MCP definitions are managed separately. Print the exact executable and script
   paths from the exported definition in your built copy:

   ```sh
   node --input-type=module -e 'import { mcpServer } from "./dist/index.js"; console.log(JSON.stringify(mcpServer, null, 2))'
   ```

   Keep this built directory available for the lifetime of the MCP definition.
   Installing a plugin snapshot does not relocate a separately registered process.
   Register the printed executable and absolute script path:

   ```sh
   agh mcp add community-evidence --name "Community evidence" --stdio /absolute/path/to/node --arg /absolute/path/to/mcp-skills/mcp/server.mjs
   agh mcp get community-evidence
   ```

3. In Settings → MCP, review that local process and choose Enable. The CLI
   alternative is mcp trust and mcp enable, each using the latest revision
   returned by mcp get; see [MCP management](../../../docs/guide/mcp.md).
   Deployment executable restrictions still apply.
4. Create a new session. Ask it to use the **mcp-skills** Skill, discover the
   connected server's answer tool, call it with a nonempty question, and read
   evidence://reference using the server's resource bridge. Expect 42 and the
   reference text. Use agh mcp tools community-evidence to inspect actual names;
   the Host prefixes tools and supplies res_list, res_tpls, and res_read.

This follows the [MCP and Skills support matrix](../../../docs/guide/mcp-skills-support.md).
A runtime Skill has no disk directory. The original SKILL.md references the asset
by relative path; registration rewrites that link to its MCP resource URI. Read
it through res_read, rather than assuming skill_read_file can read a runtime
contribution. Runtime skill trust comes from the reviewed plugin code. No
external service, model credential, or custom skill root is needed.

## Cleanup and validation scope

Disable/remove the MCP definition through MCP management before deleting its
directory. Disable/remove the plugin separately; its fiber withdraws the Skill.
Neither operation automatically removes the other contribution. Check a new
session for removal. The example's small tests verify tool/resource handlers,
packaged evidence, real Cordis Skill registration and unregistering. They do not
start an MCP process or prove AGH session discovery; complete step 4 to verify that.
