import type { HostOptions } from '@agnes/host'
import type { LogFrame } from './frames.js'
import type { SharedSessionChannel } from './shared-session-channel.js'

/** Host work uses session attribution; bounded prewarm diagnostics have worker scope. */
export function workerHostLog(
  channel: Pick<SharedSessionChannel, 'log'>,
  send: (frame: LogFrame) => void,
): HostOptions['log'] {
  return Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map((level) => [
      level,
      (message: string, fields?: { traceId?: unknown; spanId?: unknown }) => {
        try {
          channel.log(
            level,
            message,
            typeof fields?.traceId === 'string' && typeof fields?.spanId === 'string'
              ? { traceId: fields.traceId, spanId: fields.spanId }
              : undefined,
          )
        } catch {
          // Host assembly and worker-wide maintenance have no session context.
          if (message.startsWith('Default composition prewarm '))
            send({ kind: 'log', sessionKey: '@shared', level, message })
        }
      },
    ]),
  ) as HostOptions['log']
}
