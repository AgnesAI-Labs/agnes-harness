import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export type PresetDoc = Record<string, unknown> & { name: string; extends?: string }

/** Replaced with reviewed package assets by the CLI SEA build. */
declare const AGNES_CODE_PRESET_TEXTS: Readonly<Record<string, string>> | undefined
declare const AGNES_CODE_MINIMAL_SHA256: string | undefined

/**
 * Registration order, which is also the order the Profile template lists as its allowed presets.
 * Adding a recipe means adding its name here and shipping `presets/<name>.yaml`; the two are checked
 * against each other, so a name without a file fails rather than resolving to nothing.
 */
export const PRESET_NAMES = ['standard', 'claw', 'channel', 'minimal-rl', 'standard-windows'] as const
export type PresetName = (typeof PRESET_NAMES)[number]

function isPresetName(name: string): name is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(name)
}

/**
 * Parses one recipe and checks that it declares the name it was filed under. A file that says
 * something else would otherwise be loadable under two names and win silently under the wrong one.
 */
export function parsePreset(text: string, name: string): PresetDoc {
  const doc = parse(text) as unknown
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    throw new Error(`preset ${name}.yaml is not a mapping`)
  const asDoc = doc as PresetDoc
  if (asDoc.name !== name) throw new Error(`preset ${name}.yaml declares name=${String(asDoc.name)}`)
  return asDoc
}

export function loadPreset(name: string): PresetDoc {
  if (!isPresetName(name)) throw new Error(`unknown preset: ${name}`)
  const text =
    typeof AGNES_CODE_PRESET_TEXTS === 'undefined'
      ? readFileSync(join(PRESETS_DIR, `${name}.yaml`), 'utf8')
      : AGNES_CODE_PRESET_TEXTS[name]
  if (text === undefined) throw new Error(`unknown bundled preset: ${name}`)
  return parsePreset(text, name)
}

export function loadAllPresets(): Record<string, PresetDoc> {
  // The gate runs before any recipe is handed out, and there is deliberately no way past it: this
  // function is what the package's named export calls at module load, so a drifted baseline stops
  // the package being imported rather than being reported by a test somebody can skip.
  verifyFrozenPreset()
  const out: Record<string, PresetDoc> = {}
  for (const n of PRESET_NAMES) out[n] = loadPreset(n)
  return out
}

/** The recipe whose exact bytes are frozen, because a training baseline that drifts measures a different thing. */
const FROZEN = 'minimal-rl'

/** Where this package's recipes live. Both frozen-gate functions take a directory so a test can point them elsewhere. */
export const PRESETS_DIR = fileURLToPath(new URL('../../presets/', import.meta.url))

/**
 * The recorded hash. Missing or unreadable is a refusal that says how to fix itself: the gate runs
 * at module load, so this failure stops every import of the package, and an ENOENT naming a file
 * nobody has heard of is the wrong thing to hand whoever hits it.
 */
export function readFrozenSha256(dir: string = PRESETS_DIR): string {
  if (dir === PRESETS_DIR && typeof AGNES_CODE_MINIMAL_SHA256 !== 'undefined')
    return AGNES_CODE_MINIMAL_SHA256
  const file = join(dir, `${FROZEN}.sha256`)
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    throw new Error(
      `E_PRESET_INVALID: the frozen hash for ${FROZEN} is missing or unreadable at ${file}; regenerate it with \`pnpm --filter @agnes/code gen\``,
    )
  }
}

export const MINIMAL_RL_SHA256 = readFrozenSha256()

/**
 * The freeze gate: the bytes on disk against the bytes that were signed. It is a byte comparison and
 * not a parse, so a reordered mapping, a changed comment and a changed value all fail it alike -
 * which is the point. A run measured against this baseline is comparable to another run only if the
 * recipe was identical, and "identical" cannot be a judgement call made per edit.
 */
export function verifyFrozenPreset(dir: string = PRESETS_DIR): void {
  const expected = readFrozenSha256(dir)
  const actual = createHash('sha256')
    .update(
      dir === PRESETS_DIR && typeof AGNES_CODE_PRESET_TEXTS !== 'undefined'
        ? (AGNES_CODE_PRESET_TEXTS[FROZEN] ?? '')
        : readFileSync(join(dir, `${FROZEN}.yaml`)),
    )
    .digest('hex')
  if (actual !== expected)
    throw new Error(`E_PRESET_INVALID: ${FROZEN} bytes changed (expected ${expected}, got ${actual})`)
}
