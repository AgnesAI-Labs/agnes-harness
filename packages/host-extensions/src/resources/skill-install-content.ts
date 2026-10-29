import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { SkillInstallRequest } from '@agnes/extension-api'
import type { SkillDescriptor } from '@agnes/protocol'
import type { SkillInstallAuthority } from './skill-install.js'
import {
  buildInstallBundle,
  type InstallBundle,
  type InstallSkillRoot,
  installDigest,
  installError,
  type SkillDiscovery,
  safeName,
  unlinked,
} from './skill-install-files.js'

export function parseInstallInput(value: unknown): SkillInstallRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw installError('SKILL_INSTALL_INVALID')
  const input = value as Record<string, unknown>
  const keys =
    input.action === 'prepare'
      ? ['action', 'sourceDirectory', 'scope', 'enable']
      : input.action === 'prepare-content'
        ? ['action', 'name', 'files', 'scope', 'enable']
        : ['action', 'proposalId']
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key)))
    throw installError('SKILL_INSTALL_INVALID')
  if (input.action === 'prepare' || input.action === 'prepare-content') {
    if ((input.scope !== 'workspace' && input.scope !== 'user') || typeof input.enable !== 'boolean')
      throw installError('SKILL_INSTALL_INVALID')
    if (
      input.action === 'prepare' &&
      (typeof input.sourceDirectory !== 'string' || input.sourceDirectory.length > 4096)
    )
      throw installError('SKILL_INSTALL_INVALID')
    if (input.action === 'prepare-content' && (typeof input.name !== 'string' || !Array.isArray(input.files)))
      throw installError('SKILL_INSTALL_INVALID')
  } else if (
    !['commit', 'status', 'cancel'].includes(String(input.action)) ||
    typeof input.proposalId !== 'string' ||
    !/^skill-install-[0-9a-f-]{36}$/.test(input.proposalId)
  )
    throw installError('SKILL_INSTALL_INVALID')
  return structuredClone(input) as SkillInstallRequest
}

/** A conservative data-only allowlist. Scripts, manifests and unknown formats use code review. */
export async function inlineInstallBundle(
  input: Extract<SkillInstallRequest, { action: 'prepare-content' }>,
  root: InstallSkillRoot,
  discovery: SkillDiscovery,
): Promise<InstallBundle> {
  if (!safeName(input.name)) throw installError('SKILL_NAME_INVALID')
  if (!input.files.length || input.files.length > 33) throw installError('SKILL_SIZE_LIMIT')
  const files = new Map<string, Buffer>()
  const seen = new Set<string>()
  let total = 0
  for (const file of input.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      Object.keys(file).some((key) => !['path', 'content'].includes(key))
    )
      throw installError('SKILL_INSTALL_INVALID')
    const parts = file.path.split('/')
    if (
      file.path.length > 640 ||
      parts.length > 4 ||
      parts.some((part) => !safeName(part) || part.startsWith('.') || part === 'node_modules')
    )
      throw installError('SKILL_PATH_INVALID')
    const key = file.path.toLowerCase()
    if (seen.has(key)) throw installError('SKILL_FILE_CONFLICT')
    seen.add(key)
    if (
      parts[0]?.toLowerCase() === 'scripts' ||
      (file.path !== 'SKILL.md' &&
        (!/\.(md|txt|json|yaml|yml|csv)$/i.test(file.path) ||
          parts.at(-1)?.toLowerCase() === 'package.json' ||
          parts.at(-1)?.toLowerCase() === 'skill.md'))
    )
      throw installError('SKILL_CODE_REQUIRES_CANDIDATE')
    const bytes = Buffer.from(file.content, 'utf8')
    total += bytes.length
    if (bytes.length > 256 * 1024 || total > 4 * 1024 * 1024) throw installError('SKILL_SIZE_LIMIT')
    files.set(file.path, bytes)
  }
  for (const path of seen) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join('/'))) throw installError('SKILL_FILE_CONFLICT')
  }
  if (!files.has('SKILL.md')) throw installError('SKILL_DOCUMENT_INVALID')
  const bundle = await buildInstallBundle(input.name, files, root, discovery)
  // Discovery may omit unsupported/oversized attachments. Never approve bytes outside the revision.
  if (bundle.candidate.files?.length !== files.size - 1 && files.size !== 1)
    throw installError('SKILL_SIZE_LIMIT')
  for (const file of bundle.candidate.files ?? []) {
    const bytes = files.get(file.relativePath)
    if (!bytes || installDigest(bytes) !== file.sha256) throw installError('SKILL_DOCUMENT_INVALID')
  }
  return bundle
}

export function refuseSkillTarget(target: string): void {
  const root = unlinked(dirname(target))
  const name = basename(target).toLowerCase()
  if (
    existsSync(root) &&
    readdirSync(root).some((entry) => [name, `${name}.md`].includes(entry.toLowerCase()))
  )
    throw installError('SKILL_TARGET_CONFLICT')
}

/** Reject a known same-name Skill rather than silently shadowing or replacing it. */
export async function refuseSkillCollision(
  authority: SkillInstallAuthority,
  bundle: InstallBundle,
): Promise<void> {
  let cursor: string | undefined
  const visited = new Set<string>()
  do {
    authority.assertActive()
    const result = (await authority.resources('_agnes/v1/resources.list', {
      profile: authority.profile,
      kind: 'skill',
      workspaceId: installDigest(authority.workspaceRoot),
      ...(cursor ? { cursor } : {}),
    })) as { items: SkillDescriptor[]; nextCursor?: string }
    if (!Array.isArray(result?.items)) throw installError('SKILL_INSTALL_BAD_RECEIPT')
    if (
      result.items.some(
        (item) => item.name.trim().normalize('NFKC').toLowerCase() === bundle.candidate.normalizedName,
      )
    )
      throw installError('SKILL_TARGET_CONFLICT')
    cursor = result.nextCursor
    if (cursor && visited.has(cursor)) throw installError('SKILL_INSTALL_BAD_RECEIPT')
    if (cursor) visited.add(cursor)
  } while (cursor)
}
