import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as R from '@agnes/protocol/runtime'
import { canonicalJsonDigest as digest, validateRuntime } from '@agnes/protocol/runtime'

interface Launch {
  argv: readonly string[]
  cwd: string
  signal: AbortSignal
  cwdFd: number
  rootFd: number
  cwdRoot: string
}
export interface ReferenceSandboxOptions {
  directory: string
  authorityId: string
  tenantId: string
  policy: R.FsPolicySnapshot
  roots: Readonly<Record<'workspace' | 'home' | 'data', string>>
  readPaths: readonly string[]
  networkPolicyRef: string
  mount(ref: R.MountRef, context: CallContext): Promise<string>
  identity: {
    resolve(input: R.IdentityResolveRequest, context: CallContext): Promise<Outcome<R.AuthenticatedIdentity>>
  }
  authorize(context: CallContext): boolean | Promise<boolean>
}
interface Document {
  key: string
  owner: string
  request: string
  status: R.SandboxState
  result: R.SandboxCreateResult | null
  uncertain: boolean
}
class Rejected {
  constructor(
    readonly reason: string,
    readonly code: R.RuntimeError['code'] = 'denied',
  ) {}
}
function denied(reason: string, code: R.RuntimeError['code'] = 'denied'): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode: reason,
      message: 'Sandbox request refused',
      diagnosticId: 'reference-sandbox',
      retryAdvice: { kind: 'never' },
    },
  }
}
const equal = (left: unknown, right: unknown) => digest(left as R.JsonValue) === digest(right as R.JsonValue)
async function race<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
  let listener!: () => void
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(new Rejected('sandbox_cancelled', 'cancelled'))
    signal.addEventListener('abort', listener, { once: true })
    if (signal.aborted) listener()
  })
  try {
    return await Promise.race([task, stopped])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}
const required = new Map<'workspace' | 'home' | 'data', readonly string[]>([
  ['workspace', ['.git', '.agh/secrets', '.agnes/secrets']],
  ['home', ['.ssh']],
  ['data', ['secrets']],
])
function pieces(value: string): string[] {
  if (value === '' || value === '.') return []
  const parts = value.split('/')
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z]:/u.test(value) ||
    parts.some((item) => item === '..' || item === '.' || item === '')
  )
    throw new Rejected('sandbox_path', 'invalid_input')
  return parts
}
function beneath(parent: string, candidate: string) {
  const value = relative(parent, candidate)
  return !isAbsolute(value) && value !== '..' && !value.startsWith('../')
}
function seatbelt(config: ReferenceSandboxOptions) {
  const expressions = [
    '(version 1)',
    '(deny default)',
    '(allow process* sysctl-read process-info*)',
    '(deny network*)',
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-read* (literal "/"))',
  ]
  const metadata: string[] = []
  for (const location of config.readPaths.concat(Object.values(config.roots))) {
    let current = dirname(location)
    while (current !== '/') {
      if (!metadata.includes(current)) metadata.push(current)
      current = dirname(current)
    }
  }
  expressions.push(
    '(allow file-read-metadata ' +
      metadata.map((value) => `(literal ${JSON.stringify(value)})`).join(' ') +
      ')',
  )
  const protect: string[] = []
  for (const path of config.readPaths) {
    if (
      !isAbsolute(path) ||
      [...path].some((character) => character.codePointAt(0) === 127 || (character.codePointAt(0) ?? 0) < 32)
    )
      throw new Rejected('sandbox_path', 'invalid_input')
    expressions.push(`(allow file-read* (subpath ${JSON.stringify(path)}))`)
  }
  for (const entry of config.policy.rules) {
    const target = join(config.roots[entry.root], ...pieces(entry.path))
    if (entry.effect === 'hard-deny')
      protect.push(`(deny file-read* file-write* (subpath ${JSON.stringify(target)}))`)
    if (entry.effect !== 'allow') continue
    const except = config.policy.rules
      .filter(
        (item) =>
          item.effect !== 'allow' && beneath(target, join(config.roots[item.root], ...pieces(item.path))),
      )
      .map(
        (item) =>
          '(require-not (subpath ' +
          JSON.stringify(join(config.roots[item.root], ...pieces(item.path))) +
          '))',
      )
    const clause = except.length
      ? `(require-all (subpath ${JSON.stringify(target)}) ${except.join(' ')})`
      : `(subpath ${JSON.stringify(target)})`
    expressions.push(`(allow file-read* file-write* ${clause})`)
  }
  return expressions.concat(protect).join(' ')
}
function probe(config: ReferenceSandboxOptions, cwd: string, target: string, signal: AbortSignal) {
  return new Promise<{ status: number | null; text: string }>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/sandbox-exec',
      ['-p', seatbelt(config), '/usr/bin/stat', '-f', '%z', target],
      { cwd, env: { LANG: 'C' }, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let text = ''
    const stop = () => child.kill('SIGKILL')
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.stderr.on('data', (data: Buffer) => {
      text += data.toString()
      if (text.length > 2048) stop()
    })
    child.once('error', reject)
    child.once('close', (status) => {
      signal.removeEventListener('abort', stop)
      resolve({ status, text })
    })
  })
}

/** Array cabinet and short-lived Seatbelt probes, independent of the Host implementation. */
export function createReferenceSandbox(raw: ReferenceSandboxOptions) {
  const config = {
    ...raw,
    policy: structuredClone(raw.policy),
    roots: { ...raw.roots },
    readPaths: [...raw.readPaths],
  }
  const binding: R.BindingRef = {
    bindingId: 'agh.reference/sandbox/binding',
    providerId: 'agh.reference/sandbox',
    logicalName: 'sandbox',
    contract: 'agh.sandbox',
  }
  const providerDigest = digest({ implementation: 'array-cabinet-seatbelt', contract: binding.contract })
  // guards-allow-platform: the reference advertises only its actually supported backend.
  const capable = process.platform === 'darwin'
  const rootsAtOpen = Object.values(config.roots).map((location) => {
    const stat = lstatSync(location)
    return { location, device: stat.dev, inode: stat.ino }
  })
  if (!existsSync(config.directory)) mkdirSync(config.directory, { mode: 0o700, recursive: true })
  chmodSync(config.directory, 0o700)
  const file = join(config.directory, 'sandbox-cabinet.json')
  const documents = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Document[]) : []
  const operations = new Set<Promise<unknown>>(),
    live = new Map<string, { stop: AbortController; operations: Set<Promise<unknown>> }>()
  const ending = new AbortController()
  let close: Promise<void> | undefined
  function persist() {
    if (!capable) return
    const temporary = `${file}.${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(documents), { mode: 0o600, flag: 'wx' })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    const dir = openSync(config.directory, 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  }
  for (const document of documents)
    if (!['stopped', 'lost'].includes(document.status)) {
      document.status = 'lost'
      document.uncertain = true
    }
  persist()
  function deadline(context: CallContext) {
    const remaining = Date.parse(context.deadline) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0 || context.signal.aborted)
      throw new Rejected('sandbox_cancelled', 'cancelled')
    return AbortSignal.any([context.signal, ending.signal, AbortSignal.timeout(Math.min(remaining, 60000))])
  }
  async function authorized(context: CallContext) {
    if (ending.signal.aborted) throw new Rejected('sandbox_closed')
    const signal = deadline(context)
    const answer = await race(
      signal,
      config.identity.resolve({ principalRef: context.principalRef }, context),
    )
    if (
      !answer.ok ||
      !validateRuntime('AuthenticatedIdentity', answer.value).ok ||
      answer.value.principalRef !== context.principalRef ||
      answer.value.tenantRef !== config.tenantId ||
      Date.parse(answer.value.expiresAt) <= Date.now() ||
      !equal(context.scope, config.policy.scope) ||
      !(await race(signal, Promise.resolve(config.authorize(context))))
    )
      throw new Rejected('sandbox_denied')
    signal.throwIfAborted()
  }
  async function mount(ref: R.MountRef, context: CallContext) {
    const logical = config.policy.roots.find((item) => item.kind === 'workspace')?.mount
    if (
      !logical ||
      logical.mountId !== ref.mountId ||
      logical.workspaceId !== ref.workspaceId ||
      !('workspaceId' in context.scope) ||
      context.scope.workspaceId !== ref.workspaceId ||
      Date.parse(ref.lease.expiresAt) <= Date.now()
    )
      throw new Rejected('sandbox_mount')
    const directory = await race(
      deadline(context),
      config.mount(ref, context).catch(() => {
        throw new Rejected('sandbox_mount')
      }),
    )
    for (const previous of rootsAtOpen) {
      const current = await lstat(previous.location)
      if (current.isSymbolicLink() || current.dev !== previous.device || current.ino !== previous.inode)
        throw new Rejected('sandbox_mount')
    }
    const canonical = await realpath(directory)
    if (
      canonical !== directory ||
      canonical !== config.roots.workspace ||
      !(await lstat(directory)).isDirectory()
    )
      throw new Rejected('sandbox_mount')
    return directory
  }
  const holder = (context: CallContext) => digest({ principal: context.principalRef, scope: context.scope })
  async function document(ref: R.SandboxRef, context: CallContext) {
    await authorized(context)
    const found = documents.find((entry) => entry.key === ref.sandboxId)
    if (!found || found.owner !== holder(context) || !found.result || !equal(found.result.sandboxRef, ref))
      throw new Rejected('sandbox_owner')
    return found
  }
  function failure(problem: unknown) {
    return problem instanceof Rejected ? denied(problem.reason, problem.code) : denied('sandbox_unavailable')
  }
  function track<T>(promise: Promise<T>) {
    operations.add(promise)
    void promise.finally(() => operations.delete(promise))
    return promise
  }
  async function create(input: unknown, context: CallContext): Promise<Outcome<R.SandboxCreateResult>> {
    try {
      await authorized(context)
      const validated = validateRuntime('SandboxCreateRequest', input)
      if (!validated.ok) throw new Rejected('sandbox_schema', 'invalid_input')
      const request = validated.value
      if (!capable || request.mode !== 'isolated-process')
        return denied('sandbox_isolation_unsupported', 'incompatible')
      if (
        !equal(request.filesystemPolicy, config.policy) ||
        request.networkPolicyRef !== config.networkPolicyRef
      )
        throw new Rejected('sandbox_policy')
      const { digest: ignored, ...body } = config.policy
      if (digest(body) !== ignored) throw new Rejected('sandbox_policy')
      for (const [root, paths] of required)
        for (const path of paths)
          if (
            !config.policy.rules.some(
              (entry) =>
                entry.root === root &&
                entry.path === path &&
                entry.effect === 'hard-deny' &&
                ['read', 'write', 'stat', 'list'].every((access) => entry.access.includes(access as 'read')),
            )
          )
            throw new Rejected('sandbox_policy')
      if (
        config.policy.rules.some(
          (entry) =>
            !['read', 'write', 'stat', 'list'].every((access) => entry.access.includes(access as 'read')),
        )
      )
        return denied('sandbox_policy_unsupported', 'incompatible')
      for (const root of required.keys())
        if (
          !config.policy.roots.some((entry) => entry.kind === root) ||
          (await realpath(config.roots[root])) !== config.roots[root]
        )
          throw new Rejected('sandbox_policy')
      const cwd = await mount(request.workspaceRef, context)
      if (Object.values(request.resourceLimits).includes(0)) return denied('sandbox_zero_limit', 'quota')
      const key = digest([context.bindingId, context.invocationId]),
        requestDigest = digest({ body: request, owner: holder(context) })
      const previous = documents.find((entry) => entry.key === key)
      if (previous) {
        if (previous.request !== requestDigest) return denied('sandbox_request_identity', 'conflict')
        if (previous.status !== 'ready' || !previous.result)
          return denied('sandbox_unknown', 'unknown_effect')
        return { ok: true, value: previous.result }
      }
      const entry: Document = {
        key,
        owner: holder(context),
        request: requestDigest,
        status: 'creating',
        result: null,
        uncertain: true,
      }
      documents.push(entry)
      persist()
      const signal = AbortSignal.any([deadline(context), AbortSignal.timeout(5000)])
      if ((await probe(config, cwd, cwd, signal)).status !== 0) throw new Rejected('sandbox_probe')
      const probes: R.FsEnforcementProof['probes'][number][] = []
      for (const [root, paths] of required)
        for (const path of paths) {
          const observation = await probe(config, cwd, join(config.roots[root], path), signal)
          if (
            observation.status === 0 ||
            !/Operation not permitted|Permission denied/u.test(observation.text)
          )
            throw new Rejected('sandbox_probe')
          probes.push({ root, path, decision: 'denied', evidenceCode: 'E_FS_DENIED' })
        }
      await authorized(context)
      await mount(request.workspaceRef, context)
      signal.throwIfAborted()
      const proof = {
        policyDigest: config.policy.digest,
        provider: binding,
        authorityEpoch: request.workspaceRef.lease.epoch,
        checkedAt: new Date().toISOString(),
        scope: context.scope,
        workspaceRoot: { mount: request.workspaceRef, policyDecision: 'allow' as const, exists: true },
        probes,
      }
      const result: R.SandboxCreateResult = {
        sandboxRef: {
          authorityId: config.authorityId,
          sandboxId: key,
          ownerBinding: binding,
          lease: request.workspaceRef.lease,
        },
        achievedIsolation: 'isolated-process',
        limits: request.resourceLimits,
        filesystemProof: { ...proof, digest: digest(proof) },
      }
      if (!validateRuntime('SandboxCreateResult', result).ok) throw new Rejected('sandbox_probe')
      entry.status = 'ready'
      entry.result = result
      entry.uncertain = false
      persist()
      live.set(key, { stop: new AbortController(), operations: new Set() })
      return { ok: true, value: result }
    } catch (problem) {
      return failure(problem)
    }
  }
  return {
    binding,
    providerDigest,
    features: capable ? ['create', 'stop', 'inspect', 'seatbelt', 'closed-network', 'live-mount'] : [],
    create(input: unknown, context: CallContext) {
      return track(create(input, context))
    },
    inspect(input: unknown, context: CallContext): Promise<Outcome<R.SandboxInspectResult>> {
      return track(
        (async () => {
          try {
            const parsed = validateRuntime('SandboxInspectRequest', input)
            if (!parsed.ok) throw new Rejected('sandbox_schema', 'invalid_input')
            const entry = await document(parsed.value.sandboxRef, context)
            return { ok: true as const, value: { state: entry.status, usage: [] } }
          } catch (problem) {
            return failure(problem)
          }
        })(),
      )
    },
    stop(input: unknown, context: CallContext): Promise<Outcome<R.SandboxStopResult>> {
      return track(
        (async () => {
          try {
            const parsed = validateRuntime('SandboxStopRequest', input)
            if (!parsed.ok) throw new Rejected('sandbox_schema', 'invalid_input')
            const entry = await document(parsed.value.sandboxRef, context),
              owned = live.get(entry.key)
            if (entry.status !== 'stopped') {
              entry.status = 'stopping'
              persist()
              owned?.stop.abort()
              const drained = await Promise.allSettled([...(owned?.operations ?? [])])
              entry.uncertain ||= drained.some((result) => result.status === 'rejected')
              entry.status = 'stopped'
              persist()
            }
            return {
              ok: true as const,
              value: {
                terminationReceipt: {
                  authorityId: config.authorityId,
                  receiptId: `stop:${entry.key}`,
                  digest: digest(parsed.value.sandboxRef),
                },
                effectStatus: entry.uncertain ? ('unknown' as const) : ('confirmed' as const),
              },
            }
          } catch (problem) {
            return failure(problem)
          }
        })(),
      )
    },
    withExecution<T>(
      request: R.ExecRequest,
      context: CallContext,
      execute: (launch: Launch) => Promise<T>,
    ): Promise<Outcome<T>> {
      return track(
        (async () => {
          let clock: ReturnType<typeof setInterval> | undefined
          const handles: number[] = []
          try {
            const entry = await document(request.sandboxRef, context),
              owner = live.get(entry.key)
            if (entry.status !== 'ready' || !owner || !entry.result) throw new Rejected('sandbox_stopped')
            if (
              !equal(entry.result.filesystemProof.workspaceRoot.mount, request.cwd.mount) ||
              Object.entries(request.limits).some(
                ([name, value]) => value > (entry.result?.limits[name as keyof R.ResourceLimits] ?? 0),
              )
            )
              throw new Rejected('sandbox_mount')
            const root = await mount(request.cwd.mount, context)
            let cwd = root
            for (const component of pieces(request.cwd.path)) {
              cwd = join(cwd, component)
              if ((await lstat(cwd)).isSymbolicLink()) throw new Rejected('sandbox_path', 'invalid_input')
            }
            if (!beneath(root, await realpath(cwd)) || !(await lstat(cwd)).isDirectory())
              throw new Rejected('sandbox_path', 'invalid_input')
            const revoked = new AbortController()
            let busy = false
            clock = setInterval(() => {
              if (!busy) {
                busy = true
                void mount(request.cwd.mount, context)
                  .catch(() => revoked.abort())
                  .finally(() => {
                    busy = false
                  })
              }
            }, 25)
            const signal = AbortSignal.any([
              deadline(context),
              owner.stop.signal,
              revoked.signal,
              AbortSignal.timeout(Math.max(1, Date.parse(request.cwd.mount.lease.expiresAt) - Date.now())),
            ])
            await authorized(context)
            await mount(request.cwd.mount, context)
            signal.throwIfAborted()
            const access = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
            const rootHandle = openSync(root, access)
            handles.push(rootHandle)
            const rootStat = fstatSync(rootHandle),
              pinned = rootsAtOpen.find((previous) => previous.location === root)
            if (!pinned || rootStat.dev !== pinned.device || rootStat.ino !== pinned.inode)
              throw new Rejected('sandbox_mount')
            const cwdHandle = openSync(cwd, access)
            handles.push(cwdHandle)
            if (!beneath(root, realpathSync(cwd))) throw new Rejected('sandbox_path', 'invalid_input')
            const pending = execute({
              argv: ['/usr/bin/sandbox-exec', '-p', seatbelt(config), ...request.argv],
              cwd,
              cwdFd: cwdHandle,
              rootFd: rootHandle,
              cwdRoot: root,
              signal,
            })
            owner.operations.add(pending)
            try {
              const value = await pending
              const reply = value as Outcome<R.ExecResult>
              if (reply.ok === false) {
                const detail = reply.error.safeDetail as
                  | { metrics?: { ownershipVerified?: boolean; remaining?: number } }
                  | undefined
                if (detail?.metrics?.ownershipVerified !== true || detail.metrics.remaining !== 0) {
                  entry.uncertain = true
                  persist()
                }
              }
              return { ok: true as const, value }
            } finally {
              owner.operations.delete(pending)
            }
          } catch (problem) {
            return failure(problem)
          } finally {
            if (clock) clearInterval(clock)
            for (const descriptor of handles) closeSync(descriptor)
          }
        })(),
      )
    },
    close() {
      close ??= (async () => {
        ending.abort()
        for (const owner of live.values()) owner.stop.abort()
        await Promise.allSettled([...operations])
      })()
      return close
    },
  }
}
