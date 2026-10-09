import { createHash } from 'node:crypto'
import type { ToolContext } from '@agnes/extension-api'
import type { UiSurface } from '@agnes/protocol'

export function interactionSurfaceId(toolUseId: string): string {
  return 'card-' + createHash('sha256').update(toolUseId).digest('hex').slice(0, 48)
}
export async function renderInteractionSurface(ctx: ToolContext, surface: UiSurface): Promise<void> {
  const result = await ctx.tools.invoke('ui_render', { surface }, { signal: ctx.signal })
  if (result.isError) throw new Error('Surface rendering failed')
}
export function tableSurface(
  toolUseId: string,
  title: string,
  columns: string[],
  rows: string[][],
): UiSurface {
  return {
    id: interactionSurfaceId(toolUseId),
    revision: 1,
    title: title.slice(0, 256),
    placement: { inline: true, workbench: true, preferred: 'inline' },
    components: [
      {
        id: 'rows',
        kind: 'table',
        dataKey: 'rows',
        rowKey: 'id',
        selection: 'none',
        columns: columns.map((label, i) => ({ key: 'c' + i, label })),
      },
    ],
    data: {
      rows: rows.map((row, i) =>
        Object.fromEntries([['id', String(i)], ...row.map((cell, j) => ['c' + j, cell])]),
      ),
    },
    actions: [],
  }
}
