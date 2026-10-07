import { defineExtension } from '@agnes/extension-api'
import { openScheduleCatalog, openSeamScheduleDb, type ScheduleCatalog } from './catalog.js'
import { createScheduleTools } from './tools.js'

type ScheduleTable = Parameters<typeof openSeamScheduleDb>[0]
export type ScheduleTableStore = { table(name: string): ScheduleTable }

const cards = new Map<string, { sessionKey: string; target: string }>()

function bind(toolUseId: string, sessionKey: string, target: string): void {
  if (cards.size >= 200) {
    const oldest = cards.keys().next().value
    if (oldest !== undefined) cards.delete(oldest)
  }
  cards.set(toolUseId, { sessionKey, target })
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

export function createScheduleExtension(tables?: ScheduleTableStore) {
  const catalog: ScheduleCatalog | undefined = tables
    ? openScheduleCatalog(openSeamScheduleDb(tables.table('schedules')))
    : undefined
  return defineExtension((agnes) => {
    const disposers = createScheduleTools(catalog, bind).map((tool) => agnes.registerTool(tool))
    disposers.push(
      agnes.registerSlot('tool.card.inline', async (ctx) => {
        if (ctx.trigger.kind !== 'tool_result' || !catalog) return null
        const bound = cards.get(ctx.trigger.toolUseId)
        if (!bound || bound.sessionKey !== ctx.session.key) return null
        const rows =
          bound.target === '*'
            ? catalog.list({ sessionKey: ctx.session.key }).filter((row) => row.status === 'active')
            : [catalog.read(bound.target)].filter((row) => row !== undefined)
        if (rows.length === 0) return null
        return {
          title: 'Reminder',
          table: {
            columns: ['Title', 'Next', 'Status'],
            rows: rows.map((row) => [
              clip(row.title, 1024),
              row.nextRunAt === null ? '' : new Date(row.nextRunAt).toISOString(),
              row.status,
            ]),
          },
        }
      }),
    )
    disposers.push(
      agnes.registerSlot('notification', async (ctx) => {
        if (ctx.trigger.kind !== 'turn_end' || !catalog) return null
        const note = catalog.recentDelivery(ctx.session.key, Date.now() - 120_000)
        return note ? { title: clip(note.title, 256), body: clip(note.prompt, 4096) } : null
      }),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

export default createScheduleExtension()
