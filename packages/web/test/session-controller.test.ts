/** @vitest-environment happy-dom */
import type { LedgerEvent, Session } from '@agnes/sdk/browser'
import { expect, it } from 'vitest'
import { createSessionController } from '../src/app/session-controller.js'

it.each(['x/core/control', 'user/message'])(
  'keeps late %s refresh errors scoped to the selection that requested them',
  async (type) => {
    for (const selection of ['current', 'other', 'returned']) {
      let reject!: (error: Error) => void
      const failure = new Promise<never>((_, no) => {
        reject = no
      })
      const session = { id: 'a' } as Session
      let shown = 'ready'
      const context = {
        current: session,
        sessionRows: [],
        selection: 1,
        refreshSessionControls: () => failure,
        list: () => failure,
        showError: (error: unknown) => {
          shown = (error as Error).message
        },
        titleRefresh: { start() {}, stop() {} },
        sessionTitles: new Map(),
        receipts: new Map(),
      }
      const controller = createSessionController(
        context as unknown as Parameters<typeof createSessionController>[0],
      )
      const work = controller.followEvent(session, {
        seq: 1,
        ts: '2026-10-15T00:00:00Z',
        type,
        data: {},
      } as LedgerEvent)
      if (selection !== 'current') {
        context.current = { id: 'b' } as Session
        context.selection++
        if (selection === 'returned') {
          context.current = session
          context.selection++
        }
      }
      reject(new Error('earlier refresh failed'))
      await work
      await Promise.resolve()
      expect(shown).toBe(selection === 'current' ? 'earlier refresh failed' : 'ready')
    }
  },
)
