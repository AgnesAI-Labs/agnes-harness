import { CoreError, type EventInput } from '@agnes/core-common/types'
import type { AppendOptions } from '@agnes/core-ledger/log/session-log'
import type { LoopContext } from '@agnes/extension-api'
import type { LoopScope } from '../step/loop-deadline.js'
import type { SessionImpl } from '../step/session.js'

const owners = new WeakMap<object, object>()
/** Stable identity for session-owned caches; execution-owned state uses the scope token. */
export const sessionIdentity = (session: object): object => owners.get(session) ?? session

/**
 * Propagate an immutable execution generation through Core helpers. All state still belongs to the
 * session; only its writer and control-claim receiver are scoped. In particular, an async helper
 * cannot accidentally pick up the replacement driver's token after an await.
 */
export function sessionForLoop(session: SessionImpl): SessionImpl {
  const scope = session.loopScope
  const effects = new Map<string, number>()
  const receipts = new Set(['effect/settled', 'tool/result', 'x/core/tool-response', 'assistant/message'])
  async function append(events: EventInput[], options: AppendOptions = {}) {
    const settlements = events.filter((row) => row.type === 'effect/settled')
    const lateReceipt = async () => {
      const sources = settlements.map((row) =>
        effects.get(String((row.data as { effectId: string }).effectId)),
      )
      // Only Core's settlement of an intent this execution actually committed has this authority.
      if (!sources.length || sources.some((seq) => seq === undefined)) scope.assertAlive()
      const rows = events.filter((row) => row.type === 'cost/ledger')
      rows.push(
        session.ev(
          'x/core/late-effect-receipt',
          {
            version: 1,
            effects: settlements.map((row) => row.data),
            receipts: events
              .filter((row) => receipts.has(row.type))
              .map((row) => ({ type: row.type, data: row.data })),
          },
          { ignorable: true, sourceEventSeqs: sources as number[] },
        ),
      )
      const committed = await session.d.log.append(rows)
      for (const row of settlements) effects.delete(String((row.data as { effectId: string }).effectId))
      throw new CoreError('E_CLOSED', 'Loop receipt settled after revocation', {
        ...(rows[0]?.type === 'cost/ledger' ? { costSeq: committed.firstSeq } : {}),
      })
    }
    if (!scope.alive) return lateReceipt()
    try {
      const committed = await session.d.log.append(events, {
        ...options,
        commitCheck: () => {
          scope.assertAlive()
          options.commitCheck?.()
        },
      })
      events.forEach((row, index) => {
        const seq = committed.seqs[index]
        if (row.type === 'effect/intent' && seq !== undefined)
          effects.set(String((row.data as { effectId: string }).effectId), seq)
        if (row.type === 'effect/settled') effects.delete(String((row.data as { effectId: string }).effectId))
      })
      return committed
    } catch (error) {
      if (!scope.alive && settlements.length && error instanceof CoreError && error.code === 'E_CLOSED')
        return lateReceipt()
      throw error
    }
  }
  const log = new Proxy(session.d.log, {
    get(target, key) {
      if (key === 'append') return append
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const deps = new Proxy(session.d, {
    get(target, key, receiver) {
      return key === 'log' ? log : Reflect.get(target, key, receiver)
    },
  })
  const scoped = new Proxy(session, {
    get(target, key, receiver) {
      if (key === 'd') return deps
      if (key === 'loopScope') return scope
      if (key === 'controls') return controls
      if (key === 'loopChildrenPort') return session.loopChildrenPort.bind(session)
      return Reflect.get(target, key, receiver)
    },
  })
  const controls = new Proxy(session.controls, {
    get(target, key, receiver) {
      if (key === 's') return scoped
      return Reflect.get(target, key, receiver)
    },
  })
  owners.set(scoped, sessionIdentity(session))
  return scoped
}

/** Guard every callable port, including iterator advancement and returned child handles. */
export function scopeLoopContext(ctx: LoopContext, scope: LoopScope): LoopContext {
  function result(value: unknown): unknown {
    if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
      const source = value as AsyncIterable<unknown>
      return {
        [Symbol.asyncIterator]() {
          const iterator = source[Symbol.asyncIterator]()
          return {
            async next() {
              scope.assertAlive()
              const next = await iterator.next()
              scope.assertAlive()
              return next
            },
            return: (value?: unknown) => iterator.return?.(value) ?? Promise.resolve({ done: true, value }),
          }
        },
      }
    }
    // Child handles carry methods as well as data; plain model/input/decision data stay detached.
    if (value && typeof value === 'object' && 'providerId' in value && 'events' in value) return ports(value)
    return value
  }
  function ports<T extends object>(port: T, path = ''): T {
    const guarded = Object.fromEntries(
      Object.entries(port).map(([key, value]) => {
        const name = `${path}.${key}`
        if (
          typeof value === 'function' &&
          ![
            '.checkpoints.read',
            '.turn.view',
            '.turn.cancelled',
            '.turn.continuation',
            '.input.pending',
            '.services.get',
            '.effects.status',
          ].includes(name)
        )
          return [
            key,
            (...args: unknown[]) => {
              try {
                scope.assertAlive()
              } catch (error) {
                if (
                  [
                    '.turn.view',
                    '.turn.cancelled',
                    '.turn.continuation',
                    '.input.pending',
                    '.services.get',
                    '.model.stream',
                    '.children.events',
                  ].includes(name)
                )
                  throw error
                return Promise.reject(error)
              }
              const returned = value.apply(port, args)
              return returned instanceof Promise
                ? returned.then((value) => {
                    scope.assertAlive()
                    return result(value)
                  })
                : result(returned)
            },
          ]
        return [key, value && typeof value === 'object' && !Array.isArray(value) ? ports(value, name) : value]
      }),
    ) as T
    return Object.isFrozen(port) ? Object.freeze(guarded) : guarded
  }
  return ports(ctx)
}
