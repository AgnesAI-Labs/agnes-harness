import { resolveToolCallPolicy } from '@agnes/extension-api'
import { createPluginTestRegistration } from '@agnes/host/testkit/plugin-registration'
import { createPluginTestHost, driveLoop } from '@agnes/plugin-runtime/testkit'
import { createSkillCandidateRegistry, createSkillCordisService } from '@agnes/resource-control-runtime'

/** Public author testkit plus explicit loop/policy/skill ports; no private workspace imports. */
export async function runWorkflow(main, { approve = true, checkpoint, context = {} } = {}) {
  const loops = new Map(),
    policies = new Map()
  const skills = createSkillCandidateRegistry({ barrier: { quiesce: async (_id, publish) => publish({}) } })
  const registry = (map) => ({
    register(_source, provider) {
      map.set(provider.id, provider)
      return () => map.delete(provider.id)
    },
  })
  const registration = createPluginTestRegistration()
  const host = await createPluginTestHost(main, {
    context,
    registration: {
      ...registration,
      install(root, origins) {
        registration.install(root, origins)
        root.provide('loops', registry(loops))
        root.provide('toolPolicies', registry(policies))
        root.provide('skills', createSkillCordisService(skills))
      },
    },
  })
  try {
    const factory = [...loops.values()][0],
      policy = [...policies.values()][0]
    const execute = async (call, signal) => {
      const definition = host.tools.get(call.name)
      if (!definition) throw new Error('Unregistered tool')
      const decision = policy.decide({ policy: resolveToolCallPolicy(definition, call.args), call }, signal)
      if (decision.effect === 'deny' || (decision.effect === 'ask' && !approve))
        return { content: [{ type: 'text', text: 'Human refused the business action' }], isError: true }
      return host.invoke(call.name, call.args, signal)
    }
    const result = await driveLoop(factory, {
      inputs: [{ content: [{ type: 'text', text: 'Run the synthetic workflow.' }] }],
      checkpoint,
      replies: [
        [
          { type: 'text_delta', delta: 'Reviewed fixture evidence.' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      tools: { execute, batch: (calls, signal) => Promise.all(calls.map((call) => execute(call, signal))) },
    })
    return {
      ...result,
      skills: skills
        .snapshot()
        .list()
        .map((skill) => skill.name),
    }
  } finally {
    await host.dispose()
  }
}
