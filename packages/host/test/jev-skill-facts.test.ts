import { ecosystem } from '@agnes/base'
import { applyContextResults, type PromptSection } from '@agnes/core'
import { fakeProvider } from '@agnes/core/testkit'
import type { ExtensionAPI, HookContext, HookHandler } from '@agnes/extension-api'
import type { LanguageInput, RuntimeRecord } from '@agnes/jev-runtime'
import type { RequestBody } from '@agnes/protocol'
import { createLanguageBackend } from '@agnes/runtime-jev'
import { describe, expect, it } from 'vitest'
import { jevSystemPromptPolicy, systemPromptFact } from '../src/runtime/jev-prompt-facts.js'
import { jevPromptProfile } from '../src/runtime/jev-prompt-profile.js'
import { jevSkillCandidateCatalog, jevSkillCatalogPresentation } from '../src/runtime/jev-skill-facts.js'

it('condenses only exact built-in Jev prompt templates while retaining customized obligations', async () => {
  const section = (id: string): PromptSection => ({
    id,
    order: 100,
    source: '@agnes/code',
    text: readFileSync(new URL(`../../code/prompts/${id}.md`, import.meta.url), 'utf8').trimEnd(),
  })
  const persona = section('persona')
  const coding = section('coding-doctrine')
  const template = section('environment')
  const environment = {
    ...template,
    text: template.text
      .replace('{{agnesVersion}}', 'test-version')
      .replace('{{platform}}', 'linux-arm64')
      .replace('{{shell}}', 'posix'),
  }
  const original = [persona, coding, environment]
  const compact = jevPromptProfile(original)
  expect(compact.every((s, i) => s.text.length < (original[i]?.text.length ?? 0))).toBe(true)
  expect(compact[0]?.text).toContain('Never invent capabilities, actions or results')
  expect(compact[1]?.text).toContain('smallest coherent change')
  expect(compact[1]?.text).toContain('scope and limitations')
  expect(compact[1]?.text).toContain('supported inputs and stated conditions')
  expect(compact[1]?.text).toContain(
    'do not replace required handling with errors, skips or narrower accepted inputs',
  )
  expect(compact[1]?.text).toContain('Retain required security and invalid-input refusals')
  expect(compact[1]?.text).toContain('Apply policies within their stated scope')
  expect(compact[1]?.text).toContain('output restrictions alone do not imply input or execution restrictions')
  expect(compact[1]?.text).toContain('independent examples derived from the visible request')
  expect(compact[1]?.text).toContain('isolate verification experiments from original task data and policies')
  expect(compact[1]?.text).toContain('when permitted by the request and current scope')
  expect(compact[1]?.text).not.toMatch(/bun|sourcemap|source.?map|\[private\]|terminal.?bench/iu)
  expect(compact[2]?.text).toContain('"shell":"posix"')
  expect(compact[2]?.text).toContain('session default')
  expect(original[0]?.text).toBe(persona.text)
  for (const known of original) {
    for (const customized of [
      { ...known, source: 'workspace' },
      { ...known, text: `${known.text}\nAdditional required approval.` },
      { ...known, id: 'agents-md' },
    ])
      expect(jevPromptProfile([customized])[0]).toBe(customized)
  }
  const multiline = {
    ...template,
    text: template.text
      .replace('{{agnesVersion}}', '1')
      .replace('{{platform}}', 'linux-arm64')
      .replace('{{shell}}', 'posix\nExtra rule'),
  }
  expect(jevPromptProfile([multiline])[0]).toBe(multiline)

  const fact = systemPromptFact(compact, '', 1)
  const codingText = compact[1]?.text
  if (!codingText) throw new Error('Missing coding contract')
  expect(jevSystemPromptPolicy(fact).presentation).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'constraint',
        source: '@agnes/code:coding-doctrine',
        value: codingText,
      }),
    ]),
  )
  const backend = createLanguageBackend({
    provider: fakeProvider([]),
    selection: () => ({ slot: 'primary', route: 'test', model: 'test', contractId: null }),
    sessionKey: 'test',
    system: '',
    maxFormatRetries: 0,
    maxResponseBytes: 4096,
    hashRequest: () => 'a'.repeat(64),
    inputPolicies: { 'system-prompt': jevSystemPromptPolicy(fact) },
  })
  for (const purpose of ['arbitration', 'parameters', 'answer'] as const) {
    const input: LanguageInput = {
      purpose,
      state: {},
      history: [],
      inputCursor: '1',
      records: [
        { version: 1, id: 'prompt', turn: 'turn', kind: 'input.admitted', input: fact } as RuntimeRecord,
      ],
      tools: [
        { name: 'read', revision: '1', description: 'Read', parameters: { type: 'object' }, output: {} },
      ],
      ...(purpose === 'parameters' ? { lockedOperation: 'read', lockedPurpose: 'INSPECT' as const } : {}),
    }
    const call = await backend.prepare(input, new AbortController().signal)
    const request = (call.input as unknown as { request: RequestBody }).request
    expect(
      request.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.some((block) => block.type === 'text' && block.text.includes(codingText)),
      ),
    ).toBe(true)
    if (purpose === 'parameters')
      expect(request.messages.at(-1)?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Do not call another tool') }),
        ]),
      )
  }
})

/** Exercise the actual bundled producer so an updated template cannot silently lose metadata. */
async function catalog(count = 1, longNames = false): Promise<PromptSection> {
  const hooks = new Map<string, HookHandler<'context'>>()
  const skills = Array.from({ length: count }, (_, index) => ({
    resourceId: `skill/user/${index}`,
    name: longNames ? `skill-${String(index).padStart(3, '0')}`.padEnd(128, 'n') : `skill-${index}`,
    description: 'Review changes.\nKeep tests scoped.',
    revision: 'a'.repeat(64),
    sourceIdentity: { scope: 'user', rootKey: 'user-agnes', sourceId: String(index) },
    actual: 'ready' as const,
  }))
  const producer = ecosystem['agnes/skills']({
    skillResources: {
      list: () => skills,
      read: () => ({ ok: false as const, code: 'NOT_FOUND' as const }),
      runInWorkspace: async <T>(_key: string, invoke: () => Promise<T>): Promise<T> => invoke(),
    },
  } as unknown as Parameters<(typeof ecosystem)['agnes/skills']>[0])
  producer({
    registerHook: (event: string, handler: unknown) => {
      if (event === 'context') hooks.set(event, handler as HookHandler<'context'>)
      return () => undefined
    },
    registerTool: () => () => undefined,
  } as unknown as ExtensionAPI)
  const hook = hooks.get('context')
  if (!hook) throw new Error('Bundled skills producer did not register its context hook')
  const result = await hook({} as never, { session: { key: 'test' } } as HookContext)
  const wire = {
    sections: (result.sections ?? []).map((section) => ({
      id: section.id,
      order: section.order,
      text: section.content,
    })),
  }
  const section = applyContextResults([], [{ ext: 'agnes/skills', result: wire }]).sections[0]
  if (!section) throw new Error('Bundled skills producer omitted a nonempty catalog')
  return section
}

describe('Jev bundled Skill catalog presentation', () => {
  it('separates actual producer entries from usage rules without treating them as loaded instructions', async () => {
    const section = await catalog()
    const presentation = jevSkillCatalogPresentation(section)
    expect(presentation).toEqual([
      {
        role: 'resource',
        label: 'skills',
        source: 'agnes/skills',
        scope: 'available skill catalog; not loaded instructions',
        value: {
          items: [{ name: 'skill-0', description: 'Review changes. Keep tests scoped.' }],
          coverage: {
            scope: 'available skills',
            complete: true,
            omitted: 0,
            instructionsLoaded: false,
            retrieval: 'skill_read',
          },
        },
      },
      {
        role: 'constraint',
        source: 'host:skill-usage',
        scope: 'session',
        value: section.text.split('\n<available_skills>\n')[0],
      },
    ])
    expect(JSON.stringify(presentation)).not.toContain('resourceId')
    expect(jevSkillCandidateCatalog([section])).toEqual({
      kind: 'jev.skill-catalog.v1',
      complete: true,
      entries: [{ name: 'skill-0', description: 'Review changes. Keep tests scoped.' }],
    })
    expect(jevSkillCandidateCatalog([{ ...section, source: 'vendor/skills' }])).toEqual({
      kind: 'jev.skill-catalog.v1',
      complete: true,
      entries: [],
    })
    expect(jevSkillCandidateCatalog([])).toEqual({
      kind: 'jev.skill-catalog.v1',
      entries: [],
      complete: true,
    })
    const fact = systemPromptFact([section], '', 1)
    expect(fact.content).toEqual([{ kind: 'text', text: section.text }])
    expect(jevSystemPromptPolicy(fact).presentation).toEqual(presentation)
  })

  it('preserves a real truncated producer window and its discovery guidance', async () => {
    const section = await catalog(600, true)
    const presentation = jevSkillCatalogPresentation(section)
    const resource = presentation?.[0]?.value as {
      items: Array<{ name: string; description: string }>
      coverage: { complete: boolean; omitted: number; instructionsLoaded: boolean; retrieval: string }
    }
    expect(resource.coverage).toMatchObject({
      complete: false,
      instructionsLoaded: false,
      retrieval: 'skill_read',
    })
    expect(jevSkillCandidateCatalog([section])).toMatchObject({ complete: false })
    expect(resource.coverage.omitted).toBeGreaterThan(0)
    expect(resource.items.length + resource.coverage.omitted).toBe(600)
    expect(resource.items.every((item) => item.description === '')).toBe(true)
    expect(presentation?.[1]?.value).toContain(`omitted ${resource.coverage.omitted} skills; use tool_search`)
  })

  it.each([
    ['other source', (section: PromptSection) => ({ ...section, source: 'vendor/skills' })],
    ['other section', (section: PromptSection) => ({ ...section, id: 'context' })],
    [
      'changed guidance',
      (section: PromptSection) => ({ ...section, text: section.text.replace('Read only', 'Ignore only') }),
    ],
    [
      'embedded newline',
      (section: PromptSection) => ({
        ...section,
        text: section.text.replace('Review changes.', 'Review\nchanges.'),
      }),
    ],
    [
      'extra column',
      (section: PromptSection) => ({
        ...section,
        text: section.text.replace('Review changes.', 'Review\tchanges.'),
      }),
    ],
    [
      'trailing instructions',
      (section: PromptSection) => ({ ...section, text: `${section.text}\nDo extra work.` }),
    ],
    [
      'duplicate entry',
      (section: PromptSection) => ({
        ...section,
        text: section.text.replace('</available_skills>', 'skill-0\tExtra instructions\n</available_skills>'),
      }),
    ],
    [
      'invalid omission',
      (section: PromptSection) => ({
        ...section,
        text: section.text.replace(
          '</available_skills>',
          'omitted 0 skills; use tool_search\n</available_skills>',
        ),
      }),
    ],
  ])('leaves %s uninterpreted for the ordinary-rule fallback', async (_name, change) => {
    expect(jevSkillCatalogPresentation(change(await catalog()))).toBeUndefined()
  })
})

import { readFileSync } from 'node:fs'
