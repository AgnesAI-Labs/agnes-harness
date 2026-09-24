import type { ExtensionAPI, ToolDef } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import type { McpCatalogHub } from '../../mcp-server/src/catalog-hub.js'
import { mcpSearchExtension } from '../src/index.js'

function fakeApi() {
  const tools: ToolDef[] = []
  const disposed: string[] = []
  return {
    api: {
      registerTool: (tool: ToolDef) => {
        tools.push(tool)
        return () => disposed.push(tool.name)
      },
      ctx: { log: { debug() {}, info() {}, warn() {}, error() {} } },
    } as unknown as ExtensionAPI,
    disposed,
    tools,
  }
}

/** Only what `toolSearchTool`/`toolDescribeTool` actually read: `search`/`get`. The rest of
 * `McpCatalogHub` (`upsert`/`remove`/`clear`) is exercised in mcp-server/test/catalog-hub.test.ts. */
function fakeCatalogHub(rows: Record<string, { description: string; schema: string }>): McpCatalogHub {
  return {
    upsert() {},
    remove() {},
    clear() {},
    search(query) {
      const q = query.toLocaleLowerCase()
      return Object.keys(rows)
        .filter((name) => name.toLocaleLowerCase().includes(q))
        .map((name) => ({ name, score: 1 }))
    },
    get(name) {
      const row = rows[name]
      return row ? { name, ...row } : undefined
    },
  }
}

describe('mcpSearchExtension', () => {
  it('registers exactly tool_search and tool_describe', () => {
    const { api, tools } = fakeApi()
    const factory = mcpSearchExtension({ catalogHub: fakeCatalogHub({}) })

    factory(api)

    expect(tools.map((tool) => tool.name)).toEqual(['tool_search', 'tool_describe'])
  })

  it('tool_search reads through the given catalog hub, not some other index', async () => {
    const { api, tools } = fakeApi()
    const catalogHub = fakeCatalogHub({
      mcp_gh_list_prs: { description: 'list pull requests', schema: '{}' },
    })
    const factory = mcpSearchExtension({ catalogHub })

    factory(api)

    const search = tools.find((tool) => tool.name === 'tool_search') as ToolDef
    const result = await search.execute({ query: 'list_prs' }, fakeToolContext())
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('mcp_gh_list_prs') })
  })

  it('tool_describe reads through the given catalog hub', async () => {
    const { api, tools } = fakeApi()
    const catalogHub = fakeCatalogHub({
      mcp_gh_merge: { description: 'merge a pull request', schema: '{"type":"object"}' },
    })
    const factory = mcpSearchExtension({ catalogHub })

    factory(api)

    const describe = tools.find((tool) => tool.name === 'tool_describe') as ToolDef
    const result = await describe.execute({ name: 'mcp_gh_merge' }, fakeToolContext())
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('merge a pull request') })
  })

  it('dispose unregisters both tools', () => {
    const { api, disposed } = fakeApi()
    const factory = mcpSearchExtension({ catalogHub: fakeCatalogHub({}) })

    const dispose = factory(api) as () => void
    dispose()

    expect(disposed).toEqual(['tool_describe', 'tool_search'])
  })
})
