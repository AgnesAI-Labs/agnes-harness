import { dataDir, listChildCandidates, sessionsDbPath } from '@agnes/host'
import type { BootDeps } from '../types.js'
import type { Section } from './doctor-local.js'

export async function doctorSubagents(
  deps: Pick<BootDeps, 'home'>,
  opts: { repair?: boolean; json?: boolean } = {},
): Promise<{ text: string; json: unknown; exitCode: number; section: Section }> {
  const dbPath = sessionsDbPath(dataDir(deps.home))
  const candidates = listChildCandidates(dbPath)
  if (opts.repair) {
    const payload = {
      dbPath,
      candidates,
      refused: 'doctor --repair is disabled in this release; worktrees are kept for manual cleanup',
    }
    const detail = [
      'repair refused: automatic takeover, resume, and delete are disabled in this release',
      `${candidates.length} candidate(s) listed read-only`,
    ]
    return {
      text: opts.json ? JSON.stringify(payload, null, 2) : detail.join('\n'),
      json: payload,
      exitCode: 2,
      section: { name: 'subagents', status: 'warn', detail },
    }
  }
  const payload = { dbPath, candidates }
  const detail = [
    `${candidates.length} candidate(s)`,
    ...candidates.map(
      (c) =>
        `${c.childKey} state=${c.state}${c.keepReason ? ` keep=${c.keepReason}` : ''}${c.path ? ` path=${c.path}` : ''}`,
    ),
    'read-only; --repair is disabled in this release',
  ]
  const section: Section = {
    name: 'subagents',
    status: 'ok',
    detail,
  }
  return {
    text: opts.json ? JSON.stringify(payload, null, 2) : detail.join('\n'),
    json: payload,
    exitCode: 0,
    section,
  }
}
