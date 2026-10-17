import { defineWorkflowLoop, workflowValue } from '@agnes/plugin-runtime'

const candidateResult = (output) => ({ candidate: workflowValue(output).candidate })
const qualitySummary = (output) => {
  const value = workflowValue(output)
  return {
    freshness: value.freshness,
    counts: value.counts,
    authority: value.authority,
    verified: false,
    importedDigest: value.importedDigest,
  }
}

/** Select this Loop explicitly; ordinary sessions keep their existing Loop. */
export const qualityWorkflow = defineWorkflowLoop({
  id: 'skill-quality.review',
  version: '0.1.0',
  name: 'Skill candidate quality review',
  validateSettings(settings) {
    if (
      Object.keys(settings).some(
        (key) =>
          !['candidateId', 'expectedHash', 'files', 'evidenceJson', 'currentInstalledHash'].includes(key),
      ) ||
      Buffer.byteLength(JSON.stringify(settings)) > 128 * 1024
    )
      throw new Error('QUALITY_WORKFLOW_SETTINGS_INVALID')
    return settings
  },
  stages: [
    {
      name: 'candidate',
      approval: true,
      async run(ctx, state, signal) {
        const files = state.settings.files
        const call = files
          ? {
              action: state.settings.candidateId ? 'write' : 'create',
              files,
              ...(state.settings.candidateId
                ? { candidateId: state.settings.candidateId, expectedHash: state.settings.expectedHash }
                : {}),
            }
          : { action: 'read', candidateId: state.settings.candidateId }
        return {
          receipt: candidateResult(
            await ctx.tools.execute({ name: 'skill_quality_candidate', args: call }, signal),
          ),
        }
      },
    },
    {
      name: 'quality-evidence',
      approval: true,
      async run(ctx, state, signal) {
        const candidate = state.data.receipt.candidate
        if (!state.settings.evidenceJson) return { quality: { freshness: 'unknown', verified: false } }
        return {
          quality: qualitySummary(
            await ctx.tools.execute(
              {
                name: 'skill_quality_import',
                args: {
                  candidateId: candidate.candidateId,
                  evidenceJson: state.settings.evidenceJson,
                  ...(Object.hasOwn(state.settings, 'currentInstalledHash')
                    ? { currentInstalledHash: state.settings.currentInstalledHash }
                    : {}),
                },
              },
              signal,
            ),
          ),
        }
      },
    },
    {
      name: 'host-test',
      approval: true,
      async run(ctx, state, signal) {
        const candidate = state.data.receipt.candidate
        return {
          tested: candidateResult(
            await ctx.tools.execute(
              {
                name: 'skill_quality_candidate',
                args: {
                  action: 'test',
                  candidateId: candidate.candidateId,
                  expectedHash: candidate.candidateHash,
                },
              },
              signal,
            ),
          ),
        }
      },
    },
    {
      name: 'submit-for-human-review',
      approval: true,
      confirm: () => 'Submit the tested candidate for human review? This does not publish or enable it.',
      async run(ctx, state, signal) {
        const candidate = state.data.tested.candidate
        return {
          submitted: candidateResult(
            await ctx.tools.execute(
              {
                name: 'skill_quality_candidate',
                args: {
                  action: 'submit',
                  candidateId: candidate.candidateId,
                  expectedHash: candidate.candidateHash,
                },
              },
              signal,
            ),
          ),
        }
      },
    },
  ],
})
export const workflow = qualityWorkflow.main
