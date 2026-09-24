import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    statSync(p).isDirectory() ? walk(p) : e.endsWith('.ts') && files.push(p)
  }
}
walk(srcDir)

// This package is the product shell: presets, prompts and (later) the code-mode extension. It is
// assembled *by* host and driven *by* daemon/cli, so importing any of them would invert the
// direction of the dependency. `@agnes/enterprise` is a separate governance product that must stay
// optional, so the shell may not reach into it either.
const FORBIDDEN = ['@agnes/host', '@agnes/daemon', '@agnes/cli', '@agnes/enterprise']

// One `not.toContain("from '@agnes/host")` per name was the obvious spelling and misses three
// perfectly ordinary ways to reach the same module: double quotes, `await import(...)` and
// `require(...)`. All four spellings are matched, per module name.
const importSpellings = (mod: string): RegExp[] => {
  const m = mod.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
  return [
    new RegExp(String.raw`from\s*['"]${m}(['"/])`),
    new RegExp(String.raw`import\s*\(\s*['"]${m}(['"/])`),
    new RegExp(String.raw`require\s*\(\s*['"]${m}(['"/])`),
  ]
}

// Mirrors the repo-wide guard in tools/guards/src/platform.test.ts, which is the authority. It is
// repeated here so that this package's own test run fails on a platform branch without needing the
// whole repo suite, and so that the spellings that evaded the first version of the repo guard
// (destructuring off process, index access, a named import from node:os) fail here too.
const PLATFORM_PATTERNS: RegExp[] = [
  /\bprocess\.(?:platform|arch)\b/,
  /\bprocess\[\s*(['"])(?:platform|arch)\1\s*\]/,
  /\{[^}]*\b(?:platform|arch)\b[^}]*\}\s*=\s*process\b/,
  /\bos\.(?:platform|arch|type|release)\(\)/,
  /\bimport\s*\{[^}]*\b(?:platform|arch|type|release)\b[^}]*\}\s*from\s*['"](?:node:)?os['"]/,
]

describe('code package boundary', () => {
  it('finds source files to scan at all (a silent empty walk would pass every case below)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('never imports host / daemon / cli / enterprise, in any import spelling', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const forbidden of FORBIDDEN)
        for (const re of importSpellings(forbidden))
          expect(re.test(text), `${f} imports ${forbidden}`).toBe(false)
    }
  })

  it('matches every import spelling it claims to (so the case above is not a dead regex)', () => {
    const samples = [
      "import { x } from '@agnes/host'",
      'import { x } from "@agnes/host"',
      "import type { X } from '@agnes/host/assemble.js'",
      "const m = await import('@agnes/host')",
      "const m = require('@agnes/host')",
    ]
    for (const line of samples)
      expect(
        importSpellings('@agnes/host').some((re) => re.test(line)),
        line,
      ).toBe(true)
    // A package whose name merely starts the same way is not a match.
    expect(importSpellings('@agnes/host').some((re) => re.test("from '@agnes/hostile'"))).toBe(false)
  })

  it('never branches on the platform', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const re of PLATFORM_PATTERNS) expect(re.test(text), `${f}: ${re}`).toBe(false)
    }
  })

  it('matches every platform spelling it claims to (so the case above is not a dead regex)', () => {
    const samples = [
      'const p = process.platform',
      "const p = process['platform']",
      'const { platform } = process',
      'const p = os.platform()',
      "import { platform } from 'node:os'",
    ]
    for (const line of samples)
      expect(
        PLATFORM_PATTERNS.some((re) => re.test(line)),
        line,
      ).toBe(true)
  })

  // Pinned in both directions: a rename goes red, and so does a silent addition. Types are erased at
  // runtime and never reach the module object, so only values are listed here.
  it('exports exactly the runtime surface this package promises, and nothing more', async () => {
    const mod = await import('../src/index.js')
    expect(Object.keys(mod).sort()).toEqual([
      'BRIDGE_METHODS',
      'CODE_MODE_EVENTS',
      'CODE_MODE_EXT_ID',
      'MINIMAL_RL_SHA256',
      'PACKAGE_ID',
      'PRESETS_DIR',
      'PRESET_NAMES',
      'PROMPT_SECTIONS',
      'PY_RESERVED',
      'RUN_CODE_FLAVORS',
      'RunCodeParams',
      'annotate',
      'applyVars',
      'codeModeExtension',
      'createBridge',
      'createPromptOperation',
      'createRunCodeTool',
      'createSdkRenderer',
      'ecosystem',
      'environmentFacts',
      'guardOutput',
      'hasBridgeCode',
      'loadAllPresets',
      'loadPreset',
      'loadPrompt',
      'operations',
      'presets',
      'pythonBinding',
      'readFrozenSha256',
      'readLimits',
      'renderEnvironment',
      'renderPersona',
      'renderPython',
      'renderTools',
      'runCodeDescription',
      'runtimeDoctor',
      'runtimeSnapshotFacts',
      'sectionOrder',
      'snapshotKey',
      'stripFrontmatter',
      'toBridgeError',
      'validateSections',
      'verifyFrozenPreset',
    ])
  })

  // Types are erased and never reach the module object, so the only place a renamed or newly added
  // type export shows up is the text of index.ts. Pinned the same way and for the same reason.
  it('exports exactly the type surface this package promises, and nothing more', () => {
    const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const names = [...indexSrc.matchAll(/\btype (\w+)/g)].map((m) => m[1] as string).sort()
    expect(names).toEqual([
      'BridgeHandler',
      'BridgeMethod',
      'CodeModeEvent',
      'DoctorCheck',
      'DoctorSection',
      'EnvironmentFacts',
      'GuardedOutput',
      'PresetDoc',
      'PresetName',
      'PromptDeps',
      'PromptSectionSpec',
      'RunCodeArgs',
      'RunCodeDeps',
      'RunCodeFlavor',
      'RunLimits',
      'RuntimeSnapshotFacts',
      'SdkRenderer',
      'SkipReason',
    ])
  })

  it('exports the package id', async () => {
    const mod = await import('../src/index.js')
    expect(mod.PACKAGE_ID).toBe('@agnes/code')
  })

  it('loads the runtime contract and diagnostics without exposing a fake backend or test framework', async () => {
    expect(Object.keys(await import('../src/runtime/index.js'))).toEqual(['runtimeDoctor'])
    const text = readFileSync(new URL('../src/runtime/index.ts', import.meta.url), 'utf8')
    expect(text).not.toMatch(/from ['"].*(?:fake|contract|vitest)/)
  })

  // The root may reach production diagnostics, but not a scripted backend or testkit.
  it('reaches only production diagnostics from the root module', () => {
    const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(indexSrc.match(/from ['"]\.\/runtime\/[^'"]+['"]/g)).toEqual(["from './runtime/doctor.js'"])
  })
})
