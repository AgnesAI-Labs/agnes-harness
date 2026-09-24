import { defineExtension, type ExtensionFactory } from '@agnes/extension-api'
import { catalogInfoOf } from '../../../src/mcp/catalog-info.js'
import type { McpServerConfig } from '../../../src/mcp/config.js'
import { connectMcp } from '../../../src/mcp/connect.js'
import type { McpConnection } from '../../../src/mcp/register.js'
import { registerRemoteToolsStrict } from '../../../src/mcp/register.js'
import type { McpCatalogHub } from './catalog-hub.js'
import {
  type ConnectionStatusEvent,
  RECONNECT_DEFAULTS,
  type ReconnectPolicy,
  superviseConnection,
} from './supervisor.js'

export type McpServerExtensionDeps = Readonly<{
  /** Host-private hub created once at assembly (D110'); the same handle is shared by every MCP row
   * and by `agnes/mcp-search`. */
  catalogHub: McpCatalogHub
  /** Overridable for tests; production wiring binds this to `connectMcp` (src/mcp/connect.ts). */
  connect?(cfg: McpServerConfig, signal: AbortSignal): Promise<McpConnection>
  policy?: ReconnectPolicy
  /** Handed the first connection attempt's outcome, which settles once this server's tools are
   * registered or the attempt failed. The worker waits on it at its turn boundary (design §3.8,
   * D120) so a newly enabled server is usable on the next turn; the row itself never waits. */
  onFirstAttempt?(ready: Promise<{ error?: unknown }>): void
  /** This server's live connection status as it changes over the row's whole lifetime, not just the
   * first attempt - the daemon's only source of MCP status once management-plane connections are
   * gone (design §3.2). */
  onStatus?(event: ConnectionStatusEvent): void
}>

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One extension row per configured MCP server (D118, dsh 的 `apply` + 连接监督器参照实现，落在
 * `@agnes/base`)。工厂函数本身是同步的：连接与首次目录同步在 `superviseConnection` 内部后台进行,
 * 行立刻返回,慢服务器不会拖长整次应用(否则 dsh 是等的,这里刻意不照做)。断线按 dsh 式退避重连;
 * `tools/list_changed` 触发重新同步;卸载时关闭连接、注销工具,并释放这个服务器在 `McpCatalogHub`
 * 里的搜索索引声明。
 *
 * 与设计稿(`2026-09-21-resource-rows-design.md` 第 33 行)字面文本的一处偏差:稿子写的是
 * `registerRemoteToolsStrict(…, { ownsConnection: true })`,这里改成 `ownsConnection: false`。原因:
 * 同一个连接(同一个 generation)在其生命周期内会因 `tools/list_changed` 被反复 `sync`,每次 `sync`
 * 产出一个新 disposer 并替换旧的(`superviseConnection` 的 `enqueueSync`:先调旧 disposer 注销旧工具,
 * 再跑新 sync 注册同名工具——Host 的工具表不允许同名重复登记)。旧、新 disposer 共享同一个 `conn`,
 * 不是各自独立的连接——若旧 disposer 持有 `ownsConnection: true`,它在被替换时会把接下来新
 * registration 还要用的同一个连接关掉。
 * 连接的打开与关闭因此完全交给 `superviseConnection` 自己负责(`generationDown` / `dispose` /
 * 初次 sync 失败路径都已经会 `close`),`registerRemoteToolsStrict` 在这里只负责工具/资源的注册与
 * 注销记账,不再触碰连接生命周期。
 *
 * `agnes.extension.json` 声明零 capabilities,这不是漏报:这个目录本身从不经 `package.json` 的
 * `agnes.extensions` 静态列表加载(一个固定 `agnes/mcp-server` 扩展说不通——每个服务器一行,行数随
 * 配置变化),而是像 Step 1 的 `DynamicExtension` 一样由 Host 装配在运行时按每个服务器配置构造并挂载
 * 一行;真正落地的 `agnes.registerTool`/`registerResource` 调用文本上都在 `registerRemoteToolsStrict`
 * 里(`packages/base/src/mcp/register.ts`,共用库,不在任何扩展目录下),`capabilities.test.ts` 的
 * `usedCapabilities()` 只按文本扫描各扩展自己的 `src/`,因此扫到这里确实是零——manifest 如实反映了这一点;
 * 每一行真正声明的能力在行自己的 manifest 里(`mcpServerRowsFromDefinitions`)。
 */
export function mcpServerExtension(cfg: McpServerConfig, deps: McpServerExtensionDeps): ExtensionFactory {
  return defineExtension((agnes) => {
    // This row instance's identity in the catalog hub: an update replaces the row under the same
    // server id, and only the instance that made the current claim may release it.
    const claimant = {}
    const connect =
      deps.connect ??
      ((config: McpServerConfig, signal: AbortSignal) => connectMcp(config, undefined, { signal }))
    const handle = superviseConnection(
      {
        connect: (signal) => connect(cfg, signal),
        sync: (connection, reportCatalog) =>
          registerRemoteToolsStrict(agnes, connection, cfg, {
            onCatalog: (rows) => deps.catalogHub.upsert(cfg.id, rows, claimant),
            ...(reportCatalog ? { onRemoteCatalog: (remote) => reportCatalog(catalogInfoOf(remote)) } : {}),
            ownsConnection: false,
          }),
        sleep: abortableSleep,
        ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
        log: agnes.ctx.log,
      },
      deps.policy ?? RECONNECT_DEFAULTS,
    )
    // Not awaited: the row must return immediately (see the "不阻塞应用" note above). A rejection
    // here would otherwise surface only as an unhandled promise rejection -- superviseConnection
    // already reports failures through `deps.log`, so this exists purely to keep it quiet.
    void handle.ready.catch(() => undefined)
    deps.onFirstAttempt?.(handle.ready)

    let disposed = false
    let disposal: Promise<void> | undefined
    return () => {
      if (disposed) return disposal
      disposed = true
      // `catalogHub.remove` must wait for `handle.dispose()` to fully drain the sync chain first --
      // an in-flight `sync` triggered by a last-second `tools/list_changed` could otherwise call
      // `onCatalog` (re-adding this server's rows) after an eager `remove()` already ran, leaving a
      // ghost entry nothing ever cleans up. `dispose()` guarantees no further `sync` calls follow it.
      disposal = handle.dispose().finally(() => deps.catalogHub.remove(cfg.id, claimant))
      return disposal
    }
  })
}
