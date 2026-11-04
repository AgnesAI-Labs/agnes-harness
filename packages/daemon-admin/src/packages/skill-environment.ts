import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runIsolatedCommand } from '@agnes/package-isolation'
import type { SkillEnvironmentRequirement } from '@agnes/protocol'

/** Only fixed interpreter probes run here; package scripts are never dependency checks. */
export async function skillEnvironment(
  directory: string,
  files: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<SkillEnvironmentRequirement[]> {
  const result: SkillEnvironmentRequirement[] = []
  let pkg: Record<string, unknown> = {}
  if (files.includes('package.json')) {
    const path = join(directory, 'package.json')
    if (lstatSync(path).size > 1024 * 1024) throw new Error('SKILL_MANIFEST_INVALID')
    pkg = JSON.parse(readFileSync(path, 'utf8'))
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('SKILL_MANIFEST_INVALID')
  }
  const engines =
    pkg.engines && typeof pkg.engines === 'object' ? (pkg.engines as Record<string, unknown>) : {}
  const interpreters = [
    { name: 'node', used: files.some((p) => /\.[cm]?js$/.test(p)), args: ['--version'] },
    { name: 'python', used: files.some((p) => p.endsWith('.py')), args: ['--version'] },
    { name: 'bash', used: files.some((p) => /\.(sh|bash)$/.test(p)), args: ['--version'] },
    {
      name: 'pwsh',
      used: files.some((p) => p.endsWith('.ps1')),
      args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    },
  ]
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key),
    ),
  )
  for (const interpreter of interpreters) {
    if (!interpreter.used) continue
    const required =
      typeof engines[interpreter.name] === 'string'
        ? String(engines[interpreter.name]).slice(0, 256)
        : undefined
    try {
      const probe = await runIsolatedCommand(interpreter.name, interpreter.args, {
        cwd,
        env,
        timeoutMs: 5000,
        maxOutputBytes: 4096,
        signal,
        windowsBatch: 'script',
      })
      const actual = /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0]
      const minimum = required && /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(required)
      const compare =
        minimum && actual
          ? actual
              .split('.')
              .reduce(
                (decision, part, i) => decision || Math.sign(Number(part) - Number(minimum[i + 1] ?? 0)),
                0,
              )
          : undefined
      result.push({
        name: interpreter.name,
        state: !actual
          ? 'unknown'
          : required && !minimum
            ? 'unknown'
            : compare !== undefined && compare < 0
              ? 'missing'
              : 'satisfied',
        evidence: 'probed',
        ...(required ? { required } : {}),
        ...(actual ? { actual } : {}),
      })
    } catch {
      signal.throwIfAborted()
      result.push({
        name: interpreter.name,
        state: 'missing',
        evidence: 'probed',
        ...(required ? { required } : {}),
      })
    }
  }
  if (pkg.dependencies && typeof pkg.dependencies === 'object')
    for (const [name, version] of Object.entries(pkg.dependencies).slice(0, 24))
      result.push({
        name: name.slice(0, 128),
        state: 'unknown',
        evidence: 'declared',
        required: String(version).slice(0, 256),
      })
  if (files.includes('requirements.txt') || files.includes('pyproject.toml'))
    result.push({ name: 'python dependencies', state: 'unknown', evidence: 'declared' })
  return result.slice(0, 32)
}
