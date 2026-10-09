import type { UiReadResult, UiSurfaceRecord } from '@agnes/protocol'
import { canAnswerSurface } from '@agnes/protocol/intelligent-ui'

export function pendingSurface(page: UiReadResult): UiSurfaceRecord | undefined {
  return [...page.surfaces]
    .sort((a, b) => b.updatedSeq - a.updatedSeq)
    .find(
      (record) =>
        record.status === 'open' &&
        canAnswerSurface(record.surface) &&
        !page.actions.some(
          (action) =>
            action.surfaceId === record.surface.id &&
            ['received', 'executing', 'pending-approval'].includes(action.status),
        ),
    )
}
