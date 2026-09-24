import { skillsExtension } from './runtime.js'

/** Direct loading has no privileged snapshot; ecosystem assembly supplies the real Host input. */
export default skillsExtension({} as Parameters<typeof skillsExtension>[0])

export * from './discover.js'
export {
  type SkillRuntimeActual,
  type SkillRuntimeDiscovery,
  type SkillRuntimeInput,
  skillsExtension,
} from './runtime.js'
