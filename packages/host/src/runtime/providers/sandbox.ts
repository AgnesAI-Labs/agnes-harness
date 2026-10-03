import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { WORKSPACE_SECRET_DIRS } from '@agnes/protocol'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { createExec } from '../../adapters/exec.js'
import { createPlatform } from '../../adapters/platform.js'
import { callSignal, during } from '../platform/call-limit.js'

export const SANDBOX_CONTRACT = 'agh.sandbox'
export const DEFAULT_SANDBOX_PROVIDER_ID = 'agh.default/sandbox'
type Root = 'workspace' | 'home' | 'data'
const FLOOR = [
  ['workspace', '.git'],
  ...WORKSPACE_SECRET_DIRS.map((path) => ['workspace', path] as const),
  ['home', '.ssh'],
  ['data', 'secrets'],
] as const
export type SandboxLaunch = {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  cwdFd: number
  rootFd: number
  cwdRoot: string
}
export type SandboxOptions = {
  directory: string
  authorityId: string
  tenantId: string
  policy: W.FsPolicySnapshot
  roots: Readonly<Record<Root, string>>
  readPaths: readonly string[]
  networkPolicyRef: string
  mount(ref: W.MountRef, context: CallContext): Promise<string>
  identity: {
    resolve(input: W.IdentityResolveRequest, context: CallContext): Promise<Outcome<W.AuthenticatedIdentity>>
  }
  authorize(context: CallContext): boolean | Promise<boolean>
}
export type SandboxService = {
  binding: W.BindingRef
  providerDigest: string
  features: readonly string[]
  create(input: unknown, context: CallContext): Promise<Outcome<W.SandboxCreateResult>>
  inspect(input: unknown, context: CallContext): Promise<Outcome<W.SandboxInspectResult>>
  stop(input: unknown, context: CallContext): Promise<Outcome<W.SandboxStopResult>>
  withExecution<T>(
    input: W.ExecRequest,
    context: CallContext,
    run: (launch: SandboxLaunch) => Promise<T>,
  ): Promise<Outcome<T>>
  close(): Promise<void>
}
export function sandboxRefusal(code: W.RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Sandbox operation refused',
      diagnosticId: 'sandbox-provider',
      retryAdvice: { kind: 'never' },
    },
  }
}
const same = (a: unknown, b: unknown) =>
  canonicalJsonDigest(a as W.JsonValue) === canonicalJsonDigest(b as W.JsonValue)
function pathParts(path: string): string[] {
  if (
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').includes('..')
  )
    throw new Error('sandbox_path')
  if (path === '' || path === '.') return []
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.')) throw new Error('sandbox_path')
  return parts
}
const under = (root: string, value: string) => {
  const rel = relative(root, value)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
function profile(options: SandboxOptions): string {
  const quote = (p: string) => {
    if (!isAbsolute(p) || [...p].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      throw new Error('sandbox_path')
    return JSON.stringify(p)
  }
  const rulePath = (rule: W.FsPolicySnapshot['rules'][number]) =>
    join(options.roots[rule.root], ...pathParts(rule.path))
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow process-info*)',
    '(deny network*)',
    '(allow file-write-data (literal "/dev/null"))',
  ]
  for (const path of options.readPaths) lines.push(`(allow file-read* (subpath ${quote(path)}))`)
  lines.push('(allow file-read* (literal "/"))')
  const ancestors = new Set<string>()
  for (const path of [...Object.values(options.roots), ...options.readPaths]) {
    for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent)
  }
  for (const parent of ancestors) lines.push(`(allow file-read-metadata (literal ${quote(parent)}))`)
  for (const access of ['read', 'stat', 'list', 'write'] as const) {
    const operation =
      access === 'write' ? 'file-write*' : access === 'stat' ? 'file-read-metadata' : 'file-read*'
    for (const rule of options.policy.rules.filter(
      (rule) => rule.effect === 'allow' && rule.access.includes(access),
    )) {
      const allowed = rulePath(rule)
      const denied = options.policy.rules.filter(
        (candidate) =>
          candidate.effect !== 'allow' &&
          candidate.access.includes(access) &&
          under(allowed, rulePath(candidate)),
      )
      const condition = denied.length
        ? `(require-all (subpath ${quote(allowed)}) ${denied.map((candidate) => `(require-not (subpath ${quote(rulePath(candidate))}))`).join(' ')})`
        : `(subpath ${quote(allowed)})`
      lines.push(`(allow ${operation} ${condition})`)
    }
  }
  for (const rule of options.policy.rules.filter((rule) => rule.effect === 'hard-deny'))
    lines.push(`(deny file-read* file-write* (subpath ${quote(rulePath(rule))}))`)
  return lines.join('\n')
}

export function createSandboxService(input: SandboxOptions): SandboxService {
  const options: SandboxOptions = {
    ...input,
    policy: structuredClone(input.policy),
    roots: { ...input.roots },
    readPaths: [...input.readPaths],
  }
  const binding: W.BindingRef = {
    bindingId: `${DEFAULT_SANDBOX_PROVIDER_ID}/binding`,
    contract: SANDBOX_CONTRACT,
    logicalName: 'sandbox',
    providerId: DEFAULT_SANDBOX_PROVIDER_ID,
  }
  const providerDigest = canonicalJsonDigest({ contract: SANDBOX_CONTRACT, recipe: 'seatbelt-sqlite-owner' })
  const supported = createPlatform().os === 'darwin'
  const rootIdentity = new Map(
    Object.values(options.roots).map((path) => {
      const stat = lstatSync(path)
      return [path, [stat.dev, stat.ino]] as const
    }),
  )
  if (!existsSync(options.directory)) createPrivateDirectorySync(options.directory)
  const file = join(options.directory, 'sandboxes.sqlite')
  if (!existsSync(file)) closeSync(createPrivateFileSync(file))
  const db = new DatabaseSync(file)
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sandboxes(id TEXT PRIMARY KEY, owner TEXT, fingerprint TEXT, value TEXT, state TEXT, uncertain INTEGER NOT NULL DEFAULT 0); UPDATE sandboxes SET state='lost', uncertain=1 WHERE state IN ('ready','creating','stopping')",
  )
  const lifetime = new AbortController()
  const scopes = new Map<string, { abort: AbortController; work: Set<Promise<unknown>> }>()
  const creates = new Set<Promise<unknown>>()
  const operations = new Set<Promise<unknown>>()
  function track<T>(pending: Promise<T>): Promise<T> {
    operations.add(pending)
    void pending.finally(() => operations.delete(pending))
    return pending
  }
  let closing: Promise<void> | undefined
  async function auth(context: CallContext) {
    if (lifetime.signal.aborted) throw new Error('sandbox_closed')
    if (context.signal.aborted || Date.parse(context.deadline) <= Date.now())
      throw new Error('sandbox_cancelled')
    const signal = callSignal(context, lifetime.signal, 'sandbox')
    const identity = await during(
      signal,
      'sandbox',
      options.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !identity.ok ||
      !validateRuntime('AuthenticatedIdentity', identity.value).ok ||
      identity.value.principalRef !== context.principalRef ||
      identity.value.tenantRef !== options.tenantId ||
      Date.parse(identity.value.expiresAt) <= Date.now() ||
      !same(context.scope, options.policy.scope) ||
      !(await during(signal, 'sandbox', Promise.resolve(options.authorize(context))))
    )
      throw new Error('sandbox_denied')
    if (lifetime.signal.aborted || context.signal.aborted) throw new Error('sandbox_cancelled')
  }
  async function root(mount: W.MountRef, context: CallContext) {
    const logical = options.policy.roots.find((item) => item.kind === 'workspace')?.mount
    if (!logical || logical.mountId !== mount.mountId || logical.workspaceId !== mount.workspaceId)
      throw new Error('sandbox_mount')
    const value = await during(
      callSignal(context, lifetime.signal, 'sandbox'),
      'sandbox',
      options.mount(mount, context).catch(() => {
        throw new Error('sandbox_mount')
      }),
    )
    if (
      Date.parse(mount.lease.expiresAt) <= Date.now() ||
      !same(mount.workspaceId, 'workspaceId' in context.scope ? context.scope.workspaceId : null)
    )
      throw new Error('sandbox_mount')
    for (const [path, identity] of rootIdentity) {
      const stat = await lstat(path)
      if (stat.isSymbolicLink() || stat.dev !== identity[0] || stat.ino !== identity[1])
        throw new Error('sandbox_mount')
    }
    const actual = await realpath(value)
    if (actual !== options.roots.workspace || actual !== value || !(await lstat(actual)).isDirectory())
      throw new Error('sandbox_mount')
    return actual
  }
  async function checked(ref: W.SandboxRef, context: CallContext) {
    await auth(context)
    const row = db.prepare('SELECT * FROM sandboxes WHERE id=?').get(ref.sandboxId)
    if (
      !row?.value ||
      row.owner !== canonicalJsonDigest({ principal: context.principalRef, scope: context.scope }) ||
      !same((JSON.parse(String(row.value)) as W.SandboxCreateResult).sandboxRef, ref)
    )
      throw new Error('sandbox_owner')
    return { row, value: JSON.parse(String(row.value)) as W.SandboxCreateResult }
  }
  function refused(error: unknown): Outcome<never> {
    const detail =
      error instanceof Error && error.message.startsWith('sandbox_') ? error.message : 'sandbox_unavailable'
    return sandboxRefusal(
      detail === 'sandbox_cancelled'
        ? 'cancelled'
        : detail === 'sandbox_schema' || detail === 'sandbox_path'
          ? 'invalid_input'
          : 'denied',
      detail,
    )
  }
  async function create(raw: unknown, context: CallContext): Promise<Outcome<W.SandboxCreateResult>> {
    try {
      await auth(context)
      const parsed = validateRuntime('SandboxCreateRequest', raw)
      if (!parsed.ok) throw new Error('sandbox_schema')
      const body = parsed.value
      if (!supported || body.mode !== 'isolated-process')
        return sandboxRefusal('incompatible', 'sandbox_isolation_unsupported')
      if (!same(body.filesystemPolicy, options.policy) || body.networkPolicyRef !== options.networkPolicyRef)
        throw new Error('sandbox_policy')
      const { digest: _digest, ...policyBody } = body.filesystemPolicy
      if (canonicalJsonDigest(policyBody) !== body.filesystemPolicy.digest) throw new Error('sandbox_policy')
      for (const [kind, path] of FLOOR)
        if (
          !body.filesystemPolicy.rules.some(
            (rule) =>
              rule.root === kind &&
              rule.path === path &&
              rule.effect === 'hard-deny' &&
              ['read', 'write', 'stat', 'list'].every((access) => rule.access.includes(access as 'read')),
          )
        )
          throw new Error('sandbox_policy')
      if (
        body.filesystemPolicy.rules.some(
          (rule) =>
            !['read', 'write', 'stat', 'list'].every((access) => rule.access.includes(access as 'read')),
        )
      )
        return sandboxRefusal('incompatible', 'sandbox_policy_unsupported')
      for (const kind of ['workspace', 'home', 'data'] as const) {
        if (
          !body.filesystemPolicy.roots.some((item) => item.kind === kind) ||
          (await realpath(options.roots[kind])) !== options.roots[kind]
        )
          throw new Error('sandbox_policy')
      }
      const cwd = await root(body.workspaceRef, context)
      if (Object.values(body.resourceLimits).some((limit) => limit === 0))
        return sandboxRefusal('quota', 'sandbox_zero_limit')
      const id = createHash('sha256').update(`${context.bindingId}/${context.invocationId}`).digest('hex')
      const owner = canonicalJsonDigest({ principal: context.principalRef, scope: context.scope })
      const fingerprint = canonicalJsonDigest({ body, owner })
      const previous = db.prepare('SELECT * FROM sandboxes WHERE id=?').get(id)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return sandboxRefusal('conflict', 'sandbox_request_identity')
        if (previous.state !== 'ready') return sandboxRefusal('unknown_effect', 'sandbox_unknown')
        return { ok: true, value: JSON.parse(String(previous.value)) as W.SandboxCreateResult }
      }
      const argv = profile(options)
      db.prepare("INSERT INTO sandboxes(id,owner,fingerprint,value,state) VALUES(?,?,?,NULL,'creating')").run(
        id,
        owner,
        fingerprint,
      )
      const probes: W.FsEnforcementProof['probes'][number][] = []
      const signal = AbortSignal.any([
        context.signal,
        lifetime.signal,
        AbortSignal.timeout(Math.max(1, Math.min(5000, Date.parse(context.deadline) - Date.now()))),
      ])
      const exec = createExec({ baseEnv: {} })
      const stat = (path: string) =>
        exec.run(['/usr/bin/sandbox-exec', '-p', argv, '/usr/bin/stat', '-f', '%z', path], {
          cwd,
          signal,
          timeoutMs: 1000,
          maxOutputBytes: 1024,
        })
      if ((await stat(cwd)).code !== 0) throw new Error('sandbox_probe')
      for (const [kind, path] of FLOOR) {
        const observed = await stat(join(options.roots[kind], path))
        if (observed.code === 0 || !/Operation not permitted|Permission denied/u.test(observed.stderr))
          throw new Error('sandbox_probe')
        probes.push({ root: kind, path, decision: 'denied', evidenceCode: 'E_FS_DENIED' })
      }
      await auth(context)
      await root(body.workspaceRef, context)
      if (signal.aborted) throw new Error('sandbox_cancelled')
      const proofBody = {
        policyDigest: options.policy.digest,
        provider: binding,
        authorityEpoch: body.workspaceRef.lease.epoch,
        checkedAt: new Date().toISOString(),
        scope: context.scope,
        workspaceRoot: { mount: body.workspaceRef, policyDecision: 'allow' as const, exists: true },
        probes,
      }
      const value: W.SandboxCreateResult = {
        sandboxRef: {
          authorityId: options.authorityId,
          sandboxId: id,
          ownerBinding: binding,
          lease: body.workspaceRef.lease,
        },
        achievedIsolation: 'isolated-process',
        limits: body.resourceLimits,
        filesystemProof: { ...proofBody, digest: canonicalJsonDigest(proofBody) },
      }
      if (!validateRuntime('SandboxCreateResult', value).ok) throw new Error('sandbox_probe')
      db.prepare("UPDATE sandboxes SET value=?, state='ready' WHERE id=?").run(JSON.stringify(value), id)
      scopes.set(id, { abort: new AbortController(), work: new Set() })
      return { ok: true, value }
    } catch (error) {
      return refused(error)
    }
  }
  const service: SandboxService = {
    binding,
    providerDigest,
    features: supported ? ['create', 'stop', 'inspect', 'seatbelt', 'closed-network', 'live-mount'] : [],
    create(raw, context) {
      const pending = create(raw, context)
      creates.add(pending)
      void pending.finally(() => creates.delete(pending))
      return pending
    },
    async inspect(raw, context) {
      try {
        const p = validateRuntime('SandboxInspectRequest', raw)
        if (!p.ok) throw new Error('sandbox_schema')
        const { row } = await checked(p.value.sandboxRef, context)
        return { ok: true, value: { state: String(row.state) as W.SandboxState, usage: [] } }
      } catch (error) {
        return refused(error)
      }
    },
    async stop(raw, context) {
      try {
        const p = validateRuntime('SandboxStopRequest', raw)
        if (!p.ok) throw new Error('sandbox_schema')
        await checked(p.value.sandboxRef, context)
        const owned = scopes.get(p.value.sandboxRef.sandboxId)
        db.prepare("UPDATE sandboxes SET state='stopping' WHERE id=?").run(p.value.sandboxRef.sandboxId)
        owned?.abort.abort()
        const drained = await Promise.allSettled([...(owned?.work ?? [])])
        if (drained.some((item) => item.status === 'rejected'))
          db.prepare('UPDATE sandboxes SET uncertain=1 WHERE id=?').run(p.value.sandboxRef.sandboxId)
        db.prepare("UPDATE sandboxes SET state='stopped' WHERE id=?").run(p.value.sandboxRef.sandboxId)
        return {
          ok: true,
          value: {
            terminationReceipt: {
              authorityId: options.authorityId,
              receiptId: `stop:${p.value.sandboxRef.sandboxId}`,
              digest: canonicalJsonDigest(p.value.sandboxRef),
            },
            effectStatus:
              db.prepare('SELECT uncertain FROM sandboxes WHERE id=?').get(p.value.sandboxRef.sandboxId)
                ?.uncertain === 1 || drained.some((item) => item.status === 'rejected')
                ? 'unknown'
                : 'confirmed',
          },
        }
      } catch (error) {
        return refused(error)
      }
    },
    async withExecution(body, context, run) {
      let watcher: ReturnType<typeof setInterval> | undefined
      let directoryFd: number | undefined, mountFd: number | undefined
      try {
        const { row, value } = await checked(body.sandboxRef, context)
        if (row.state !== 'ready') throw new Error('sandbox_stopped')
        if (
          !same(value.filesystemProof.workspaceRoot.mount, body.cwd.mount) ||
          (Object.keys(body.limits) as (keyof W.ResourceLimits)[]).some(
            (key) => body.limits[key] > value.limits[key],
          )
        )
          throw new Error('sandbox_mount')
        const cwdRoot = await root(body.cwd.mount, context)
        let cwd = cwdRoot
        for (const part of pathParts(body.cwd.path)) {
          cwd = join(cwd, part)
          if ((await lstat(cwd)).isSymbolicLink()) throw new Error('sandbox_path')
        }
        const physical = await realpath(cwd)
        if (!under(cwdRoot, physical) || !(await lstat(physical)).isDirectory())
          throw new Error('sandbox_path')
        const owned = scopes.get(body.sandboxRef.sandboxId)
        if (!owned) throw new Error('sandbox_stopped')
        const revoked = new AbortController()
        let polling = false
        watcher = setInterval(() => {
          if (polling) return
          polling = true
          void root(body.cwd.mount, context)
            .catch(() => revoked.abort())
            .finally(() => {
              polling = false
            })
        }, 25)
        const signal = AbortSignal.any([
          context.signal,
          lifetime.signal,
          owned.abort.signal,
          revoked.signal,
          AbortSignal.timeout(Math.max(1, Date.parse(body.cwd.mount.lease.expiresAt) - Date.now())),
        ])
        await auth(context)
        await root(body.cwd.mount, context)
        if (signal.aborted) throw new Error('sandbox_cancelled')
        mountFd = openSync(cwdRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const openedRoot = fstatSync(mountFd),
          expectedRoot = rootIdentity.get(cwdRoot)
        if (!expectedRoot || openedRoot.dev !== expectedRoot[0] || openedRoot.ino !== expectedRoot[1])
          throw new Error('sandbox_mount')
        directoryFd = openSync(cwdRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        let nextPath = cwdRoot
        for (const component of pathParts(body.cwd.path)) {
          nextPath = join(nextPath, component)
          const next = openSync(nextPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          closeSync(directoryFd)
          directoryFd = next
        }
        const pending = run({
          argv: ['/usr/bin/sandbox-exec', '-p', profile(options), ...body.argv],
          cwd: physical,
          cwdFd: directoryFd,
          rootFd: mountFd,
          cwdRoot,
          signal,
        })
        owned.work.add(pending)
        try {
          const result = await pending
          const outcome = result as Outcome<W.ExecResult>
          if (!outcome.ok) {
            const metrics = outcome.error?.safeDetail as
              | { metrics?: { ownershipVerified?: boolean; remaining?: number } }
              | undefined
            if (!metrics?.metrics?.ownershipVerified || metrics.metrics.remaining !== 0)
              db.prepare('UPDATE sandboxes SET uncertain=1 WHERE id=?').run(body.sandboxRef.sandboxId)
          }
          return { ok: true, value: result }
        } finally {
          owned.work.delete(pending)
        }
      } catch (error) {
        return refused(error)
      } finally {
        if (watcher) clearInterval(watcher)
        if (directoryFd !== undefined) closeSync(directoryFd)
        if (mountFd !== undefined) closeSync(mountFd)
      }
    },
    close() {
      closing ??= (async () => {
        lifetime.abort()
        for (const record of scopes.values()) record.abort.abort()
        await Promise.allSettled([
          ...operations,
          ...creates,
          ...[...scopes.values()].flatMap((record) => [...record.work]),
        ])
        db.close()
      })()
      return closing
    },
  }
  return {
    ...service,
    inspect: (raw, context) => track(service.inspect(raw, context)),
    stop: (raw, context) => track(service.stop(raw, context)),
    withExecution<T>(body: W.ExecRequest, context: CallContext, run: (launch: SandboxLaunch) => Promise<T>) {
      return track(service.withExecution(body, context, run))
    },
  }
}
