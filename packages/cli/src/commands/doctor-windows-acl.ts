import { join } from 'node:path'
import {
  createPlatform,
  openWindowsAclMaintenance,
  type WindowsAclMaintenance,
  type WindowsAclReport,
} from '@agnes/host'
import type { BootDeps } from '../types.js'
import type { Section } from './doctor-local.js'

/** How the command reaches this account's grants; injected in tests, real only on Windows. */
export type WindowsAclDoctorDeps = Readonly<{
  os: string
  open(): Promise<WindowsAclMaintenance>
}>

export function windowsAclDoctorDeps(
  deps: Pick<BootDeps, 'home' | 'env'>,
  profile: string,
): WindowsAclDoctorDeps {
  return {
    os: createPlatform().os,
    open: async () => {
      const localAppData = deps.env.LOCALAPPDATA
      if (!localAppData)
        throw Object.assign(new Error('LOCALAPPDATA is not set'), { code: 'E_ACL_STATE_UNSAFE' })
      return openWindowsAclMaintenance({
        profileDir: join(deps.home, 'profiles', profile),
        localAppData,
        pid: process.pid,
      })
    },
  }
}

const SIDE_EFFECTS =
  'side effects: a workspace grant adds a Low integrity label and an Everyone delete-child deny entry to the workspace folder; they stay until an explicit repair, and until then other Low integrity programs of the same Windows user may also write there'

const grantLine = (report: WindowsAclReport) =>
  report.state === 'unavailable'
    ? 'no AGH grant recorded for this folder'
    : `grant ${report.state === 'needs-attention' ? 'needs attention' : report.state}${report.grantId ? ` (${report.grantId})` : ''}`

const reportLines = (report: WindowsAclReport) => [
  grantLine(report),
  ...report.issues.map((issue) => `needs attention: ${issue.object}: ${issue.reason}`),
  ...report.steps.map((step) => `step: ${step}`),
]

const attention = (report: WindowsAclReport) => [...new Set(report.issues.map((issue) => issue.object))]

const failure = (error: unknown) => {
  const value = error as { code?: unknown; message?: unknown } | null
  const code = typeof value?.code === 'string' ? value.code : 'error'
  const message = typeof value?.message === 'string' ? value.message : String(error)
  return `${code}: ${message}`
}

/**
 * Inspects AGH's ACL grant on a workspace and the sessions saved there; changes nothing unless
 * `repair` is set. A repair works on the grant and record digest the inspection just returned, so
 * a record that moved on meanwhile is refused; the authority itself refuses a grant another
 * session still uses or cannot be proven unused, and keeps changes it did not make. Sessions whose
 * workspace directory was replaced are confirmed in place. Nothing is elevated.
 */
export async function doctorWindowsAcl(
  root: string,
  opts: Readonly<{ repair: boolean; signal?: AbortSignal }>,
  deps: WindowsAclDoctorDeps,
): Promise<{ section: Section; payload: unknown }> {
  const done = (section: Section, payload: unknown) => ({ section, payload })
  if (deps.os !== 'win32') {
    const section: Section = {
      name: 'windows-acl',
      status: 'ok',
      detail: ['Windows ACL execution is used only on Windows; nothing to inspect here.'],
    }
    return done(section, { root, applicable: false })
  }
  const detail = [`root ${root}`]
  let maintenance: WindowsAclMaintenance | undefined
  try {
    maintenance = await deps.open()
    const inspected = await maintenance.inspect(root)
    const replaced = await maintenance.replacedWorkspaces(root)
    if (!opts.repair) {
      detail.push(...reportLines(inspected))
      if (inspected.state !== 'unavailable') detail.push(SIDE_EFFECTS)
      if (replaced.length > 0)
        detail.push(`sessions whose workspace directory was replaced: ${replaced.join(', ')}`)
      if (inspected.state !== 'unavailable' || replaced.length > 0)
        detail.push(
          `run agh doctor windows-acl --cwd ${root} --repair to remove AGH's own permission changes here when no session uses them (a session's next command grants them again) and to confirm the sessions listed above; it does not elevate`,
        )
      const status = inspected.state === 'needs-attention' ? 'fail' : replaced.length > 0 ? 'warn' : 'ok'
      return done(
        { name: 'windows-acl', status, detail },
        { root, inspected, needsAttention: attention(inspected), replacedSessions: replaced },
      )
    }
    let repaired: WindowsAclReport | undefined
    let refused = false
    if (inspected.grantId && inspected.recordDigest && inspected.repairable) {
      repaired = await maintenance.repair({
        root,
        grantId: inspected.grantId,
        expectedRecordDigest: inspected.recordDigest,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      detail.push(...reportLines(repaired))
    } else {
      // Nothing of AGH's left here is not a refusal; a record that cannot be repaired is.
      refused = inspected.state === 'needs-attention'
      detail.push(
        ...reportLines(inspected),
        refused ? 'repair refused: see the reasons above' : 'nothing to repair',
      )
    }
    const confirmed: string[] = []
    const unconfirmed: string[] = []
    for (const key of replaced)
      try {
        await maintenance.confirmWorkspace(root, key)
        confirmed.push(key)
        detail.push(`confirmed ${key}: the directory now at this root is its workspace`)
      } catch (error) {
        unconfirmed.push(key)
        detail.push(`not confirmed ${key}: ${failure(error)}`)
      }
    const final = repaired ?? inspected
    const failed =
      refused ||
      unconfirmed.length > 0 ||
      (repaired !== undefined && (repaired.state !== 'revoked' || repaired.issues.length > 0))
    return done(
      { name: 'windows-acl', status: failed ? 'fail' : 'ok', detail },
      {
        root,
        inspected,
        ...(repaired ? { repaired } : {}),
        needsAttention: attention(final),
        replacedSessions: replaced,
        confirmedSessions: confirmed,
      },
    )
  } catch (error) {
    detail.push(
      failure(error),
      'Run it as the Windows user that runs AGH, in a normal terminal; this command does not elevate.',
    )
    return done({ name: 'windows-acl', status: 'fail', detail }, { root, error: failure(error) })
  } finally {
    await maintenance?.close().catch(() => undefined)
  }
}
