import { createHash } from 'node:crypto'
import { defaultToolPolicy, type ToolPolicy } from '@agnes/extension-api'

/** The application's selected role policy asks for a real human once, even in full-access mode. */
export const qualityPolicy: ToolPolicy = {
  id: 'sableleaf-quality',
  version: '1.0.0',
  decide(input, signal, ports) {
    signal.throwIfAborted()
    if (input.call.name === 'pharma_release' || input.call.name === 'pharma_record') {
      return {
        effect: 'ask',
        reason: 'Human quality-record signature / 人工质量记录签署',
        approval: {
          reviewerRequirement: 'human',
          grantConstraints: 'once',
          // Core separately binds the arguments, tool identity and policy to this subject.
          subjectRevision: createHash('sha256').update(JSON.stringify(input.call.args)).digest('hex'),
        },
      }
    }
    return defaultToolPolicy.decide(input, signal, ports)
  },
}
