import { renderInteractionSurface, tableSurface } from '../../../src/interaction-surfaces.js'
import { defineExtension } from '@agnes/extension-api'
import {
  openScheduleCatalog,
  openSeamScheduleDb,
  type ScheduleCatalog,
  type ScheduleView,
} from './catalog.js'
import { createScheduleTools } from './tools.js'

type ScheduleTable = Parameters<typeof openSeamScheduleDb>[0]
export type ScheduleTableStore = { table(name: string): ScheduleTable }

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

export function createScheduleExtension(tables?: ScheduleTableStore) {
  const catalog: ScheduleCatalog | undefined = tables
    ? openScheduleCatalog(openSeamScheduleDb(tables.table('schedules')))
    : undefined
  return defineExtension((agnes) => {
    const disposers = createScheduleTools(catalog).map((tool) =>
      agnes.registerTool({
        ...tool,
        async execute(args, ctx) {
          const result = await tool.execute(args, ctx)
          const details = result.details as
            | { id?: string; schedules?: ScheduleView[]; deleted?: boolean }
            | undefined
          const target =
            details?.id ??
            (details?.deleted && 'id' in args && typeof args.id === 'string' ? args.id : undefined)
          if (catalog && details && (target || details.schedules)) {
            const row = target ? catalog.read(target) : undefined
            const rows =
              details.schedules?.filter((row) => row.status === 'active') ??
              (row?.sessionKey === ctx.session.key ? [row] : [])
            if (rows.length)
              await renderInteractionSurface(
                ctx,
                tableSurface(
                  ctx.session.toolUseId,
                  'Reminder / 提醒',
                  ['Title', 'Next', 'Status'],
                  rows.map((row) => [
                    clip(row.title, 1024),
                    row.nextRunAt === null ? '' : new Date(row.nextRunAt).toISOString(),
                    row.status,
                  ]),
                ),
              )
          }
          return result
        },
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
