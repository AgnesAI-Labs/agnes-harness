import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const hash = (text) => createHash('sha256').update(text).digest('hex')
export const fail = (code) => {
  throw Object.assign(new Error(code), { code })
}
const leaf = (path) =>
  typeof path === 'string' && /^(?!\.)(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(path)
const secret =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^\s"']{8,}/i
const diff = (before, after) =>
  [
    '--- current',
    '+++ proposed',
    ...before.split('\n').map((line) => `-${line}`),
    ...after.split('\n').map((line) => `+${line}`),
  ].join('\n')
const text = (value, max = 2000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
const whole = (value) => {
  // Stay below the public tool-result JSON ceiling; never publish a truncated review as complete.
  if (Buffer.byteLength(JSON.stringify(value)) > 240000) fail('MEMORY_REVIEW_LIMIT')
  return value
}

/** Only consume the Host-produced memory section, never a user-supplied path or policy. */
export function memoryScope(view) {
  const section = view?.prompt.sections.find((row) => row.id === 'memory:index' && row.source === 'memory')
  if (!section) fail('MEMORY_REVIEW_DISABLED')
  const revision = /^Agent memory .* Revision: ([a-f0-9]{64})\.$/m.exec(section.text)?.[1]
  const root = /^Workspace memory directory: (.+)\. Use normal read\/write\/edit tools;/m.exec(
    section.text,
  )?.[1]
  const policy = /^Policy: (off|ask|auto)\./m.exec(section.text)?.[1]
  if (!root || !revision || !policy) fail('MEMORY_REVIEW_CONTEXT_UNAVAILABLE')
  // Require Ask at entry; the live file provider owns policy and exact approval at publication.
  if (policy !== 'ask') fail('MEMORY_REVIEW_REQUIRES_ASK')
  return { root, revision }
}

export async function scan(scope, fs, signal) {
  signal.throwIfAborted()
  const entries = await fs.list(scope.root)
  if (entries.length > 16) fail('MEMORY_REVIEW_LIMIT')
  const files = []
  let total = 0
  for (const entry of entries) {
    signal.throwIfAborted()
    if (entry.kind !== 'file' || !leaf(entry.name)) fail('MEMORY_REVIEW_INVALID_FILE')
    const path = `${scope.root}/${entry.name}`
    if ((await fs.revision?.(path)) !== scope.revision) fail('MEMORY_REVIEW_STALE')
    const bytes = await fs.read(path, { limit: 32769 })
    total += bytes.byteLength
    if (bytes.byteLength > 32768 || total > 131072) fail('MEMORY_REVIEW_LIMIT')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (secret.test(content)) fail('MEMORY_SECRET_LIKE_CONTENT')
    files.push({ path: entry.name, content, hash: hash(content) })
  }
  return whole({ revision: scope.revision, files })
}

function sources(value, snapshot) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) fail('MEMORY_REVIEW_INVALID_SOURCES')
  return value.map((source) => {
    if (!snapshot.files.some((file) => file.path === source?.path && file.hash === source?.hash))
      fail('MEMORY_REVIEW_INVALID_SOURCES')
    return { path: source.path, hash: source.hash }
  })
}

/** A proposal is untrusted model output. Every source and replacement base is snapshot-bound. */
export function preview(snapshot, proposal) {
  if (
    !Array.isArray(proposal?.groups) ||
    proposal.groups.length > 16 ||
    !Array.isArray(proposal?.edits) ||
    proposal.edits.length > 8
  )
    fail('MEMORY_REVIEW_INVALID_PROPOSAL')
  const groups = proposal.groups.map((group) => {
    if (!['duplicate', 'conflict', 'stale'].includes(group?.kind) || !text(group.reason))
      fail('MEMORY_REVIEW_INVALID_PROPOSAL')
    if (secret.test(group.reason)) fail('MEMORY_SECRET_LIKE_CONTENT')
    return { kind: group.kind, reason: group.reason, sources: sources(group.sources, snapshot) }
  })
  const seen = new Set()
  const edits = proposal.edits.map((edit) => {
    if (!leaf(edit?.path) || seen.has(edit.path) || !text(edit.reason) || typeof edit.content !== 'string')
      fail('MEMORY_REVIEW_INVALID_PROPOSAL')
    seen.add(edit.path)
    const before = snapshot.files.find((file) => file.path === edit.path)
    if (!before || before.hash !== edit.baseHash) fail('MEMORY_REVIEW_STALE')
    const evidence = sources(edit.sources, snapshot)
    const provenance = { revision: snapshot.revision, reason: edit.reason, sources: evidence }
    // Empty replacement means retire the topic with a provenance tombstone. No private unlink port.
    const content = `${edit.content}\n\nMemory review provenance (untrusted learned preference):\n\`\`\`json\n${JSON.stringify(provenance)}\n\`\`\`\n`
    if (secret.test(content)) fail('MEMORY_SECRET_LIKE_CONTENT')
    if (Buffer.byteLength(content) > (edit.path === 'MEMORY.md' ? 16384 : 32768))
      fail('MEMORY_CONSOLIDATION_REQUIRED')
    return {
      ...edit,
      sources: evidence,
      content,
      baseHash: before.hash,
      newHash: hash(content),
      diff: diff(before.content, content),
    }
  })
  // Topics first, index last. There is deliberately no claim of multi-file atomicity.
  edits.sort((a, b) => Number(a.path === 'MEMORY.md') - Number(b.path === 'MEMORY.md'))
  return whole({ version: 1, revision: snapshot.revision, groups, edits })
}

/** No direct filesystem writes: fs is the Host's memory-mediated ToolContext port. */
export async function applyReview(scope, snapshot, review, fs, signal) {
  if (scope.revision !== snapshot.revision || review?.revision !== snapshot.revision || review?.version !== 1)
    fail('MEMORY_REVIEW_STALE')
  // Rebuild the preview instead of trusting stored hashes, diff, paths or provenance.
  const proposal = {
    groups: review.groups,
    edits: review.edits.map((edit) => {
      const suffix = `\n\nMemory review provenance (untrusted learned preference):\n\`\`\`json\n${JSON.stringify({ revision: snapshot.revision, reason: edit.reason, sources: sources(edit.sources, snapshot) })}\n\`\`\`\n`
      if (typeof edit.content !== 'string' || !edit.content.endsWith(suffix))
        fail('MEMORY_REVIEW_INVALID_PROPOSAL')
      return { ...edit, content: edit.content.slice(0, -suffix.length) }
    }),
  }
  const checked = preview(snapshot, proposal)
  if (!isDeepStrictEqual(checked, review)) fail('MEMORY_REVIEW_INVALID_PROPOSAL')
  const committed = []
  for (const edit of checked.edits) {
    try {
      signal.throwIfAborted()
      const path = `${scope.root}/${edit.path}`
      if ((await fs.revision?.(path)) !== scope.revision) fail('MEMORY_REVIEW_STALE')
      if (hash(new TextDecoder().decode(await fs.read(path))) !== edit.baseHash) fail('MEMORY_REVIEW_STALE')
      await fs.write(path, edit.content)
      committed.push({ path: edit.path, hash: edit.newHash })
    } catch (error) {
      // Never echo arbitrary error text; it can contain memory or credentials.
      const code = /^MEMORY_[A-Z_]+$/.test(error?.code ?? error?.message ?? '')
        ? (error.code ?? error.message)
        : signal.aborted
          ? 'MEMORY_REVIEW_CANCELLED'
          : 'MEMORY_REVIEW_WRITE_UNKNOWN'
      return {
        status: committed.length ? 'partial' : 'failed',
        committed,
        failed: edit.path,
        code,
        remaining: checked.edits.slice(committed.length + 1).map((item) => item.path),
      }
    }
  }
  return { status: 'completed', committed }
}
