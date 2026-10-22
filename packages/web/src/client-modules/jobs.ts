import type { Client } from '@agnes/sdk/browser'
import { bindJobsSessions } from '@agnes/web-admin/settings/jobs-api'
import { registerJobsSettingsContribution } from '@agnes/web-admin/settings/registry'
import { workbenchPanels } from '@agnes/web-client'
import { TerminalPanel, terminalCount } from '@agnes/web-conversation/workbench/terminal'

/** The shared jobs client contribution consumes the session service contract, independent of its owner. */
export function registerJobsClientContribution(): () => void {
  const releases: Array<() => void> = []
  if (!workbenchPanels.get('terminal'))
    releases.push(
      workbenchPanels.register({
        id: 'terminal',
        order: 50,
        edge: 'right',
        titleKey: 'workbench.terminal.title',
        count: terminalCount,
        component: TerminalPanel,
      }),
    )
  releases.push(registerJobsSettingsContribution())
  return () => {
    for (const release of releases.reverse()) release()
  }
}

/** The application supplies its existing authenticated client and current selection. */
export function bindJobsClient(input: {
  client: Client
  current(): string | undefined
  /** The name the sidebar gives a session whose stored title is still empty. */
  untitled(id: string, createdAt: string): string
}): () => void {
  const stopJobsClient = registerJobsClientContribution()
  const stopJobsSessions = bindJobsSessions({
    call: (method, params) => input.client.call(method, params),
    current: input.current,
    async list() {
      const rows: Awaited<ReturnType<Client['session']['list']>>['items'] = []
      let cursor: string | undefined
      do {
        const page = await input.client.session.list({ limit: 500, ...(cursor ? { cursor } : {}) })
        rows.push(...page.items)
        cursor = page.next
      } while (cursor)
      // The sidebar hides archived sessions and names untitled ones from their first message; the
      // picker offers the same sessions under the same names.
      return rows
        .filter((row) => !row.archived)
        .map((row) => ({
          id: row.sessionId,
          title: row.title || input.untitled(row.sessionId, row.createdAt),
          workspace: row.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? '',
          createdAt: row.createdAt,
        }))
    },
  })
  return () => {
    stopJobsClient()
    stopJobsSessions()
  }
}
