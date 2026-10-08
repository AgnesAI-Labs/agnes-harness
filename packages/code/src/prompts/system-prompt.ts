import { type ProviderPluginContext, type SystemPromptProvider, systemPromptKind } from '@agnes/extension-api'
import { loadPrompt, PROMPT_SECTIONS } from './sections.js'

export const defaultSystemPrompt: SystemPromptProvider = {
  id: 'agnes.system-prompt',
  version: '1.0.0',
  compose(config, sections) {
    if (config.fullOverride !== undefined) {
      if (config.personaPrefix || config.personaSuffix || config.replyStyle)
        throw new Error('Full replacement conflicts with opening, closing or reply-style instructions')
      return [
        {
          id: 'deployment:full-override',
          order: 100,
          source: 'profile:system-prompt',
          text: config.fullOverride,
        },
      ]
    }
    return [
      ...(config.personaPrefix
        ? [
            {
              id: 'deployment:persona-prefix',
              order: 1,
              source: 'profile:system-prompt',
              text: config.personaPrefix,
            },
          ]
        : []),
      ...sections,
      ...(config.personaSuffix
        ? [
            {
              id: 'deployment:persona-suffix',
              order: 10000,
              source: 'profile:system-prompt',
              text: config.personaSuffix,
            },
          ]
        : []),
      ...(config.replyStyle
        ? [
            {
              id: 'deployment:reply-style',
              order: 10001,
              source: 'profile:system-prompt',
              text: config.replyStyle,
            },
          ]
        : []),
    ].sort((a, b) => a.order - b.order)
  },
  defaults: () =>
    PROMPT_SECTIONS.filter((section) => section.source === 'file').map((section) => ({
      id: section.id,
      order: section.order,
      source: `@agnes/code/prompts/${section.id}.md`,
      text: loadPrompt(section.id),
    })),
}
export const systemPromptPlugin = {
  inject: ['providers'],
  apply(ctx: ProviderPluginContext) {
    ctx.providers.register(systemPromptKind, '@agnes/code', defaultSystemPrompt)
  },
}
