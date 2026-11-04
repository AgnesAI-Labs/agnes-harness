import { parseSource } from '@agnes/package-manager'
import type { SkillImportParams } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { UsageError } from '../errors.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'

/** Prepare exposes a review digest; commit requires that exact digest as a separate action. */
export async function skillImportCommand(
  p: ParsedArgs,
  client: NodeClient,
  write: (text: string) => void,
): Promise<number> {
  const [command, action, value, detail] = p.positional
  if (
    command !== 'skill-import' ||
    !['prepare', 'commit', 'status', 'cancel'].includes(action ?? '') ||
    !value ||
    p.positional.length > 4
  )
    throw new UsageError(
      'usage: agh plugins skill-import prepare <source> [subdirectory] | commit <proposalId> <digest> | status <proposalId> | cancel <proposalId>',
    )
  if (action === 'commit' && !detail) throw new UsageError('commit requires the digest returned by prepare')
  if (!(await client.initialize()).features?.includes('packages.skill-import.v1'))
    throw new UsageError('This server does not support complete Skill imports')
  const result = await client.packages.skillImport({
    profile: p.profile ?? 'local-dev',
    clientId: await client.clientId(),
    commandId: newPackageCommandId('skill-import'),
    action: action as 'prepare' | 'commit' | 'status' | 'cancel',
    ...(action === 'prepare'
      ? {
          source: parseSource(value.replaceAll('\\', '/')) as NonNullable<SkillImportParams['source']>,
          ...(detail ? { subdirectory: detail } : {}),
          scope: 'user' as const,
          enable: false,
        }
      : { proposalId: value, ...(action === 'commit' && detail ? { expectedDigest: detail } : {}) }),
  })
  write(JSON.stringify(result, null, p.json ? undefined : 2) + '\n')
  return ['failed', 'unsupported', 'interrupted'].includes(result.state) ? 1 : 0
}
