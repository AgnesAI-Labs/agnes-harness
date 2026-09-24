import type { ToolContext } from '@agnes/extension-api'
import { type BridgeRequest, validateAgainst } from '@agnes/protocol'
import { ArtifactRef, PlanItems } from '@agnes/protocol/gen/session-v1'

function invalid(): never {
  throw Object.assign(new Error('invalid bridge parameters'), { bridgeCode: -32602 })
}
function object(value: unknown, allowed: string[], required: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(p, key)))
    return invalid()
  return p
}
const string = (value: unknown): string => (typeof value === 'string' ? value : invalid())
function options(value: unknown, kind: 'fork' | 'spawn' | 'collect') {
  const opts = object(
    value,
    kind === 'spawn' ? ['model', 'isolation', 'budget'] : kind === 'fork' ? ['model'] : ['wait'],
  )
  if (opts.model !== undefined) string(opts.model)
  if (opts.isolation !== undefined && opts.isolation !== 'worktree' && opts.isolation !== 'shared') invalid()
  if (
    opts.budget !== undefined &&
    (typeof opts.budget !== 'number' || !Number.isFinite(opts.budget) || opts.budget < 0)
  )
    invalid()
  if (opts.wait !== undefined && typeof opts.wait !== 'boolean') invalid()
  return { ...opts } as { model?: string; isolation?: 'worktree' | 'shared'; budget?: number; wait?: boolean }
}

/** Validation finishes before the returned closure may perform any operation. */
export function bridgeDispatch(ctx: ToolContext, request: BridgeRequest): () => Promise<unknown> {
  switch (request.method) {
    case 'bridge.tools.invoke': {
      const { name, args } = request.params
      return async () => {
        const result = await ctx.tools.invoke(name, args, { signal: ctx.signal })
        if (result.isError) throw new Error('tool execution failed')
        // details is UI-only; structured is the public machine-readable half when present.
        if (result.structured !== undefined) return result.structured
        return result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
      }
    }
    case 'bridge.subagent.spawn': {
      const p = object(request.params, ['task', 'opts'], ['task']),
        task = string(p.task)
      const opts = p.opts === undefined ? undefined : options(p.opts, 'spawn')
      return () => ctx.subagent.spawn(task, opts)
    }
    case 'bridge.subagent.fork': {
      const p = object(request.params, ['question', 'opts'], ['question']),
        question = string(p.question)
      const opts = p.opts === undefined ? undefined : options(p.opts, 'fork')
      return () => ctx.subagent.fork(question, opts)
    }
    case 'bridge.subagent.collect': {
      const p = object(request.params, ['childKey', 'opts'], ['childKey']),
        key = string(p.childKey)
      const opts = p.opts === undefined ? undefined : options(p.opts, 'collect')
      return () => ctx.subagent.collect(key, opts)
    }
    case 'bridge.artifacts.put': {
      const p = object(request.params, ['bytes', 'meta'], ['bytes'])
      if (
        !Array.isArray(p.bytes) ||
        !p.bytes.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
      )
        invalid()
      const bytes = Uint8Array.from(p.bytes as number[])
      const meta = p.meta === undefined ? undefined : object(p.meta, ['mime', 'name'])
      if (meta?.mime !== undefined) string(meta.mime)
      if (meta?.name !== undefined) string(meta.name)
      const rebuilt =
        meta === undefined
          ? undefined
          : {
              ...(meta.mime === undefined ? {} : { mime: meta.mime as string }),
              ...(meta.name === undefined ? {} : { name: meta.name as string }),
            }
      return () => ctx.artifacts.put(bytes, rebuilt)
    }
    case 'bridge.artifacts.get': {
      const p = object(request.params, ['ref'], ['ref'])
      const check = validateAgainst<ArtifactRef>(ArtifactRef, p.ref)
      if (!check.ok) return invalid()
      const ref = { ...check.value }
      return async () => Array.from(await ctx.artifacts.get(ref))
    }
    case 'bridge.plan.set': {
      const p = object(request.params, ['items'], ['items'])
      const check = validateAgainst<PlanItems>(PlanItems, p)
      if (!check.ok || !check.value) return invalid()
      const items = check.value.items.map((item) => ({ ...item }))
      return async () => ({ seq: await ctx.plan.set(items) })
    }
    case 'bridge.log': {
      const p = object(request.params, ['level', 'message'], ['level', 'message'])
      if (!['debug', 'info', 'warn', 'error'].includes(string(p.level))) return invalid()
      const level = p.level as 'debug' | 'info' | 'warn' | 'error',
        message = string(p.message)
      return async () => {
        ctx.log[level](message)
        return null
      }
    }
  }
}
