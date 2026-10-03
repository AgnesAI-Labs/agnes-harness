import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolDescribeTool, toolSearchTool } from '@agnes/base'
import { fakeToolContext } from '@agnes/base/testkit'
import type { WorkspaceInvocationView } from '@agnes/core'
import { expect, it } from 'vitest'
import { createReferenceResources } from '../../../../examples/runtime-reference/src/providers/resources.js'
import {
  resourceCatalogContext,
  resourceCatalogDescriptor,
  resourceCatalogFixtureInput,
} from '../../../extension-api/testkit/runtime/contracts/resources.js'
import { createExtensionActivationBarrier } from '../../src/ext-host/activation-barrier.js'
import { bindSkillRuntimeToWorkspace, createSkillPromptPreloader } from '../../src/resources/skill-preload.js'
import { createSkillCandidateRegistry } from '../../src/resources/skills.js'
import { createResourcesService } from '../../src/runtime/providers/resources.js'

it.each([createResourcesService, createReferenceResources])(
  'preserves legacy Skill discovery, deferred describe and preload beside the new catalog',
  async (create) => {
    const directory = mkdtempSync(join(tmpdir(), 'resource-builtin-'))
    const catalog = create(resourceCatalogFixtureInput(directory))
    const registry = createSkillCandidateRegistry({ barrier: createExtensionActivationBarrier() })
    const skill = {
      resourceId: `skill/workspace/workspace-agnes/${'a'.repeat(64)}`,
      name: 'review',
      description: 'Review synthetic changes',
      revision: 'b'.repeat(64),
      capabilityHash: 'c'.repeat(64),
      sourceIdentity: {
        scope: 'workspace' as const,
        rootKey: 'workspace-agnes' as const,
        sourceId: 'a'.repeat(64),
      },
      priority: 500,
      body: 'Private legacy Skill procedure',
    }
    registry.replaceRoot('workspace-agnes', [skill])
    const trust = [
      {
        resourceId: skill.resourceId,
        revision: skill.revision,
        capabilityHash: skill.capabilityHash,
        state: 'trusted' as const,
      },
    ]
    registry.setControl({ desired: [{ resourceId: skill.resourceId, state: 'enabled' }], trust })
    await registry.activate('fixture-generation', async () => {})
    const resolver = () => ({
      run: <T>(handler: (view: WorkspaceInvocationView) => Promise<T>) =>
        handler({ root: directory } as WorkspaceInvocationView),
    })
    const legacy = bindSkillRuntimeToWorkspace(registry.snapshot(), resolver)
    const context = fakeToolContext({ cwd: directory })
    const index = {
      search: () => [{ name: 'mcp_deferred', score: 1 }],
      get: (name: string) =>
        name === 'mcp_deferred'
          ? { name, description: 'Deferred synthetic tool', schema: '{"type":"object"}' }
          : undefined,
    }
    const discover = () => toolSearchTool(index, legacy).execute({ query: 'review skill', limit: 2 }, context)
    try {
      const before = await discover()
      expect(JSON.stringify(before)).toContain('Skill review')
      expect(JSON.stringify(before)).not.toContain(skill.body)
      expect(JSON.stringify(before)).not.toContain(skill.resourceId)
      const descriptor = resourceCatalogDescriptor('separate-runtime-resource')
      expect(
        (
          await catalog.call(
            'register',
            { descriptor, ownerReleaseSetId: 'fixture-release' },
            resourceCatalogContext(),
          )
        ).ok,
      ).toBe(true)
      expect(
        (await catalog.call('remove', { id: descriptor.id, expectedRevision: 1 }, resourceCatalogContext()))
          .ok,
      ).toBe(true)
      expect(await discover()).toEqual(before)
      expect(await toolDescribeTool(index).execute({ name: 'mcp_deferred' }, context)).toMatchObject({
        content: [{ text: expect.stringContaining('parameters: {"type":"object"}') }],
      })
      expect(await toolDescribeTool(index).execute({ name: 'unknown' }, context)).toMatchObject({
        isError: true,
      })
      const preload = createSkillPromptPreloader(registry.snapshot(), resolver)
      expect(
        await preload({ sessionKey: context.session.key, prompt: 'Please review this change' }),
      ).toBeUndefined()
      expect((await preload({ sessionKey: context.session.key, prompt: 'Use $review' }))?.note).toContain(
        skill.body,
      )
      registry.setControl({ desired: [{ resourceId: skill.resourceId, state: 'disabled' }], trust })
      await registry.activate('disabled-generation', async () => {})
      const disabled = bindSkillRuntimeToWorkspace(registry.snapshot(), resolver)
      expect(
        JSON.stringify(
          await toolSearchTool(index, disabled).execute({ query: 'review skill', limit: 2 }, context),
        ),
      ).not.toContain('Skill review')
      expect(registry.read(skill.resourceId, { sessionKey: context.session.key })).toEqual({
        ok: false,
        code: 'DISABLED',
      })
      expect(
        await createSkillPromptPreloader(
          registry.snapshot(),
          resolver,
        )({ sessionKey: context.session.key, prompt: 'Use $review' }),
      ).toBeUndefined()
    } finally {
      catalog.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
