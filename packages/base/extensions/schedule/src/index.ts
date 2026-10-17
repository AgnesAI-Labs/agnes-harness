import { schedulingKind } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { renderInteractionSurface, tableSurface } from '../../../src/interaction-surfaces.js'
import type { ScheduleView } from './rules.js'
import { createScheduleTools } from './tools.js'

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

export function createScheduleExtension() {
  return defineAgnesPlugin({
    inject: ['tools', 'slots', 'providers'],
    apply(plugin: Context) {
      const open = () => plugin.providers.bindOwn(schedulingKind)
      const disposers = createScheduleTools(open).map((tool) =>
        plugin.tools.register({
          ...tool,
          async execute(args: Parameters<typeof tool.execute>[0], ctx) {
            const result = await tool.execute(args, ctx)
            const details = result.details as
              | { id?: string; schedules?: ScheduleView[]; deleted?: boolean }
              | undefined
            const target =
              details?.id ??
              (details?.deleted && 'id' in args && typeof args.id === 'string' ? args.id : undefined)
            if (details && (target || details.schedules)) {
              const row = target ? await (await open()).get(target) : undefined
              const rows =
                details.schedules?.filter((row) => row.status === 'active') ??
                (row &&
                (row.origin === ctx.session.key ||
                  (row.target.kind === 'session' && row.target.sessionKey === ctx.session.key))
                  ? [row]
                  : [])
              if (rows.length)
                await renderInteractionSurface(
                  ctx,
                  tableSurface(
                    ctx.session.toolUseId,
                    'Scheduled tasks',
                    [
                      'Title',
                      'Runs in',
                      { label: 'Next', format: 'date' },
                      { label: 'Status', format: 'status' },
                    ],
                    rows.map((row) => [
                      clip(row.title, 1024),
                      row.target.kind === 'new-session'
                        ? `New session · ${clip(row.target.cwd, 512)}`
                        : 'This session',
                      row.nextRunAt === null ? '' : new Date(row.nextRunAt).toISOString(),
                      row.status,
                    ]),
                    { titleKey: 'ui.schedule' },
                  ),
                )
            }
            return result
          },
        }),
      )
      disposers.push(
        plugin.slots.register('notification', async (ctx) => {
          if (ctx.trigger.kind !== 'turn_end') return null
          const { recentDelivery: note } = await (await open()).list({
            recentDeliverySince: Date.now() - 120_000,
          })
          return note ? { title: clip(note.title, 256), body: clip(note.prompt, 4096) } : null
        }),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  })
}

export default createScheduleExtension()
