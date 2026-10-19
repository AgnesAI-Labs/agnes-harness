import { defaultToolPolicy, type ToolPolicy } from '@agnes/extension-api'

/** The application's selected role policy applies ordinary tool permission; the handler separately requests a business signature. */
export const qualityPolicy: ToolPolicy = {
  id: 'sableleaf-quality',
  version: '1.0.0',
  decide(input, signal, ports) {
    signal.throwIfAborted()
    const args = input.call.args
    if (
      input.call.name === 'pharma_report' &&
      input.policy.requiresApproval === 'never' &&
      !input.policy.isDestructive &&
      args &&
      typeof args === 'object' &&
      !Array.isArray(args) &&
      Object.keys(args).length === 2 &&
      args.kind === 'em' &&
      (args.locale === 'zh-CN' || args.locale === 'en')
    )
      return {
        effect: 'allow',
        reason: 'Synthetic EM export only: reads quality state and creates new owned report files',
      }
    return defaultToolPolicy.decide(input, signal, ports)
  },
}
