import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { Badge } from './ui/badge.js'
import { Button } from './ui/button.js'
import { MetaText } from './ui/tag.js'
import { type LocaleCatalog, useUiText } from './ui-locale.js'

type Status = NonNullable<PackageInstalledDescriptor['primaryStatus']>
const catalog: LocaleCatalog = {
  en: {
    ready: 'Ready',
    blocked: 'Blocked',
    'restart-required': 'After restart',
    'historical-only': 'History only',
    disabled: 'Disabled',
    untrusted: 'Awaiting trust',
    trust: 'Review trust',
    enable: 'Enable',
    'configure-credential': 'Configure credential',
    'install-dependency': 'Install dependency',
    restart: 'Restart instructions',
    repin: 'Review pins',
    unconfirmed: 'The backend has not confirmed plugin status.',
  },
  'zh-CN': {
    ready: '就绪',
    blocked: '受阻',
    'restart-required': '重启后生效',
    'historical-only': '仅历史',
    disabled: '已停用',
    untrusted: '待信任',
    trust: '审阅信任',
    enable: '启用',
    'configure-credential': '配置凭据',
    'install-dependency': '安装依赖',
    restart: '重启说明',
    repin: '审阅固定版本',
    unconfirmed: '后台尚未确认插件状态。',
  },
}

/** One backend-owned primary status. No client-side readiness or authorization inference. */
export function PluginPrimaryStatus({
  status,
  action,
}: {
  status: Status | undefined
  action?: { disabled: boolean; run(): void | Promise<void> } | undefined
}) {
  const { t, locale } = useUiText('@agnes/web-ui/plugin-primary-status', catalog)
  const state = status?.state ?? 'blocked'
  return (
    <div data-testid="plugin-primary-status" data-state={state}>
      <Badge
        tone={
          state === 'ready'
            ? 'ok'
            : state === 'untrusted' || state === 'blocked'
              ? 'bad'
              : state === 'restart-required'
                ? 'warn'
                : 'off'
        }
      >
        {t(state)}
      </Badge>{' '}
      <MetaText data-testid="plugin-status-reason">
        {state === 'untrusted'
          ? locale === 'zh-CN'
            ? '已安装；还需审阅信任并启用。'
            : 'Installed; review trust and enable to finish.'
          : (status?.reason[locale === 'zh-CN' ? 'zh-CN' : 'en'] ?? t('unconfirmed'))}
      </MetaText>
      {status && status.nextAction !== 'none' && action && (
        <Button
          size="small"
          disabled={action.disabled}
          onClick={(event) => {
            event.stopPropagation()
            void action.run()
          }}
        >
          {t(status.nextAction)}
        </Button>
      )}
    </div>
  )
}
