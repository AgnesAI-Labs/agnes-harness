import type { SkillDescriptor } from '@agnes/protocol'
import { type LocaleTranslator, type ResourceDetailAction, resourceDesiredEnabled } from '@agnes/web-ui'

export function skillDetailActions(
  skill: SkillDescriptor,
  disabled: boolean,
  t: LocaleTranslator,
  setDesired: (next: boolean) => Promise<void>,
  remove: () => Promise<{ operationId: string }>,
  removeAppearance: Pick<ResourceDetailAction, 'className'>,
): readonly ResourceDetailAction[] {
  if (skill.sourceIdentity.scope === 'runtime') return []
  const enabling = !resourceDesiredEnabled(skill)
  return [
    {
      label: t(enabling ? 'action.enable' : 'action.disable'),
      summary: t('action.request', {
        action: t(enabling ? 'action.enable' : 'action.disable'),
        kind: t('tab.skills'),
        name: skill.name,
        revision: `${skill.revision.slice(0, 12)}…`,
      }),
      run: async () => {
        await setDesired(enabling)
        return undefined
      },
      disabled: disabled || skill.lastSafeError?.code === 'SKILL_REMOVAL_PENDING',
    },
    ...(skill.sourceIdentity.scope === 'workspace' || skill.sourceIdentity.scope === 'user'
      ? [
          {
            label: t('action.remove-skill.label'),
            summary: t('action.remove-skill.summary', { name: skill.name }),
            run: remove,
            disabled,
            ...removeAppearance,
          },
        ]
      : []),
  ]
}

export function resourceActionMenu(
  actions: readonly ResourceDetailAction[],
  run: (action: ResourceDetailAction) => void,
) {
  return actions.map((action, index) => ({
    id: `resource-${index}`,
    label: action.label,
    disabled: action.disabled ?? false,
    danger: action.className?.includes('danger') ?? false,
    onSelect: () => run(action),
  }))
}
