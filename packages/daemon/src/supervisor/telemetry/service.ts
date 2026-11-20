import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import type { ConfigurationService, ScanRead } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import type { AdminTelemetryParams, AdminTelemetryResult } from '@agnes/protocol/gen/app-server'
import { ACTIVITY_EVENTS, ActivityWindow, activityObserver, sendActivityReport } from './activity.js'
import { telemetryAccounts } from './routes.js'
import { openTelemetrySettings, telemetryEnvironment, telemetryInstallId } from './settings.js'
import { MAX_PENDING, traceUploads } from './trace-uploads.js'
import type { TraceSession } from './traces.js'
import { channelSession, record, type Surface, telemetryRuntime } from './wire.js'

type Options = {
  home: string
  env?: NodeJS.ProcessEnv
  allowInTest?: boolean
  clock?: () => number
  configuration?: Pick<ConfigurationService, 'get'>
  scan?: (key: string) => ScanRead<EventEnvelope>
  table?: () => TableHandle
  paths?: (cwd?: string) => { privatePaths: string[]; workspacePaths: string[] }
  credentials?: () => readonly string[] | Promise<readonly string[]>
}

type Workspace = Pick<TraceSession, 'cwd' | 'extraRoots'>

const TRACE_EVENTS = new Set(['turn/end', 'x/feedback/item'])

function interval(value: string | undefined, fallback: number, minimum: number): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? Math.max(minimum, Math.min(n, 2 ** 31 - 1)) : fallback
}

/** A shared shutdown deadline protects storage from late acknowledgements on either link. */
async function drainTelemetry(
  lifecycle: AbortController,
  flows: readonly { active: () => Promise<void> | undefined; flush: () => void }[],
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 2000)
      }),
      Promise.all(
        flows.map(async ({ active, flush }) => {
          await active()
          if (lifecycle.signal.aborted) return
          flush()
          await active()
        }),
      ),
    ])
  } finally {
    lifecycle.abort()
    clearTimeout(deadline)
  }
}

function isChannelMessage(data: unknown): boolean {
  const { commandId } = record(data)
  return typeof commandId === 'string' && /^channel:[a-f0-9]{64}$/.test(commandId)
}

export async function openTelemetry(options: Options) {
  const env = options.env ?? process.env
  const { endpoint, disabledByEnv, endpointConfigured } = telemetryEnvironment(env, options.allowInTest)
  const settings = await openTelemetrySettings(options.home)
  const clock = options.clock ?? Date.now
  const runtime = telemetryRuntime(env.AGH_TELEMETRY_DISTRIBUTION)
  const lifecycle = new AbortController()
  const analytics = activityObserver()
  const privateSessions = new Set<string>()
  const surfaceBySession = new Map<string, Surface>()
  const reportInterval = interval(env.AGH_TELEMETRY_FLUSH_MS, 300_000, 100)
  const installId =
    !disabledByEnv && endpoint ? await telemetryInstallId(options.home).catch(() => undefined) : undefined
  const uploads = traceUploads({
    home: options.home,
    endpoint,
    installId,
    clock,
    runtime,
    lifecycle: lifecycle.signal,
    debounce: interval(env.AGH_TELEMETRY_TRACE_DEBOUNCE_MS, 250, 1),
    retry: interval(env.AGH_TELEMETRY_RETRY_MS, 30_000, 1),
    configuration: options.configuration,
    scan: options.scan,
    table: options.table,
    paths: options.paths,
    credentials: options.credentials,
  })
  // A daemon start is a new window too: rows committed while no daemon was uploading stay local.
  if (settings.read().traceUploadEnabled) uploads.enable(true)
  let reportCancellation = new AbortController()
  let reportTimer: ReturnType<typeof setTimeout> | undefined
  let reportRun: Promise<void> | undefined
  let window: ActivityWindow | undefined
  let daemonStarts = 1
  let closing = false

  function report(): void {
    if (reportRun || !window || !installId || !endpoint) return
    const current = window
    const starts = daemonStarts
    window = undefined
    daemonStarts = 0
    clearTimeout(reportTimer)
    reportTimer = undefined
    const signal = AbortSignal.any([lifecycle.signal, reportCancellation.signal])
    reportRun = sendActivityReport({
      current,
      starts,
      runtime,
      installId,
      endpoint,
      clock,
      traceEnabled: () => settings.read().traceUploadEnabled,
      accounts: () => telemetryAccounts(options.configuration).catch(() => []),
      signal,
    })
      .catch(() => undefined)
      .finally(() => {
        reportRun = undefined
        if (!closing && window && !reportTimer) scheduleReport()
      })
  }

  function scheduleReport(): void {
    if (reportTimer || !window) return
    reportTimer = setTimeout(
      () => {
        reportTimer = undefined
        report()
      },
      Math.max(1, window.start + reportInterval - clock()),
    )
    reportTimer.unref()
  }

  function cancelReport(): void {
    clearTimeout(reportTimer)
    reportTimer = undefined
    window = undefined
    analytics.clear()
    reportCancellation.abort()
    reportCancellation = new AbortController()
  }

  function noteSurface(key: string, surface: Surface): void {
    if (!installId || closing) return
    const oldest = surfaceBySession.keys().next().value
    if (surfaceBySession.size >= MAX_PENDING && oldest !== undefined) surfaceBySession.delete(oldest)
    surfaceBySession.set(key, surface)
  }

  return {
    async admin({ settings: patch }: AdminTelemetryParams): Promise<AdminTelemetryResult> {
      if (patch !== undefined)
        await settings.update(patch, (next) => {
          if (next.traceUploadEnabled) uploads.enable()
          else uploads.disable()
          if (!next.analyticsEnabled) cancelReport()
        })
      return { settings: settings.read(), status: { disabledByEnv, endpointConfigured } }
    },
    surface: noteSurface,
    sessionCreated(key: string, surface: Surface): void {
      noteSurface(key, surface)
      if (!installId || closing || !settings.read().analyticsEnabled) return
      window ??= new ActivityWindow(clock())
      window.surfaces.add(surface)
      window.activity.sessions_created++
      scheduleReport()
    },
    observe(key: string, event: EventEnvelope, workspace?: () => Workspace): void {
      if (!installId || closing || key.startsWith('refinement:workspace')) return
      const current = settings.read()
      if (event.type === 'session/start' && record(event.data).memory === true) {
        const oldest = privateSessions.values().next().value
        if (privateSessions.size >= MAX_PENDING && oldest !== undefined) privateSessions.delete(oldest)
        privateSessions.add(key)
      }
      if (privateSessions.has(key)) return
      if (event.type === 'user/message' && isChannelMessage(event.data)) noteSurface(key, 'channel')
      const surface = surfaceBySession.get(key) ?? (channelSession(key) ? 'channel' : 'unknown')
      if (current.analyticsEnabled && ACTIVITY_EVENTS.has(event.type)) {
        window ??= new ActivityWindow(clock())
        analytics.observe(window, key, surface, event)
        scheduleReport()
      }
      if (current.traceUploadEnabled && TRACE_EVENTS.has(event.type))
        uploads.observe(key, event.seq, surface, workspace)
    },
    async dispose(): Promise<void> {
      closing = true
      uploads.close()
      clearTimeout(reportTimer)
      await drainTelemetry(lifecycle, [
        { active: () => reportRun, flush: report },
        { active: uploads.active, flush: uploads.flush },
      ])
      uploads.clear()
    },
  }
}

export type Telemetry = Awaited<ReturnType<typeof openTelemetry>>
