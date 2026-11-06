import { Button, useDocumentLanguage } from '@agnes/web-ui'
import { callChannel } from './channel-api.js'
import { openChannelDialog } from './channel-dialog-state.js'
import { useChannelOverview } from './channel-model.js'
import { channelName } from './channel-name.js'
import { channelConnectionState } from './channel-presentation.js'
import type { HomePageData } from './host.js'

const channelData = { call: callChannel }

function status(connection: string, binding: string, stale: boolean, zh: boolean) {
  if (stale) return { label: zh ? '状态待刷新' : 'Status unavailable', tone: 'warn' }
  if (connection === 'connected') {
    if (binding === 'active') return { label: zh ? '同步中' : 'Connected', tone: 'ok' }
    return {
      label:
        binding === 'waiting' ? (zh ? '待确认' : 'Awaiting confirmation') : zh ? '待核对' : 'Needs review',
      tone: 'warn',
    }
  }
  if (['starting', 'connecting', 'reconnecting'].includes(connection))
    return { label: zh ? '连接中' : 'Connecting', tone: 'warn' }
  return {
    label: connection === 'failed' ? (zh ? '连接失败' : 'Connection failed') : zh ? '未连接' : 'Disconnected',
    tone: 'off',
  }
}

/** Session identity comes from the composer; binding and connection facts remain backend-owned. */
export function SessionChannelControl({
  sessionId,
  data = channelData,
}: {
  sessionId: string | undefined
  data?: Pick<HomePageData, 'call' | 'channelCall'>
}) {
  const zh = useDocumentLanguage() === 'zh-CN'
  const { overview, error } = useChannelOverview(data, !!sessionId)
  const bound =
    overview?.channels.flatMap((group) =>
      group.instances.flatMap((instance) =>
        instance.bindings
          .filter((binding) => binding.sessionId === sessionId)
          .map((binding) => ({ group, instance, binding })),
      ),
    ) ?? []
  if (!bound.length)
    return (
      <Button
        size="small"
        data-testid="composer-channel-binding"
        loading={!!sessionId && !overview && !error}
        disabled={!!sessionId && !overview && !error}
        onClick={() => openChannelDialog({ sessionId })}
      >
        {error ? (zh ? '渠道状态待刷新' : 'Channel status unavailable') : zh ? '渠道绑定' : 'Channels'}
      </Button>
    )
  return (
    <span className="channel-composer-connections">
      {bound.map(({ group, instance, binding }) => {
        const name = channelName(group.provider.manifest, zh)
        const state = status(
          channelConnectionState(instance.connection),
          binding.state,
          error || !!group.error,
          zh,
        )
        const label = `${name} · ${state.label}`
        return (
          <Button
            key={`${group.provider.extension}:${instance.id}:${binding.targetId}`}
            size="small"
            className="channel-composer-status"
            data-testid="composer-channel-binding"
            title={`${name} · ${binding.label} · ${instance.id}`}
            aria-label={`${zh ? '编辑渠道连接' : 'Edit channel connection'}：${label} · ${binding.label}`}
            onClick={() =>
              openChannelDialog({ sessionId, extension: group.provider.extension, instanceId: instance.id })
            }
          >
            <span className="channel-composer-dot" data-tone={state.tone} aria-hidden="true" />
            {label}
          </Button>
        )
      })}
    </span>
  )
}
