import { Badge } from '@agnes/web-ui'

export function channelConnectionState(connection: { channel: string; daemon: string } | null) {
  if (!connection) return 'stopped'
  return connection.channel === 'connected' ? connection.daemon : connection.channel
}

export function ChannelStatus({ state, zh }: { state: string; zh: boolean }) {
  const labels: Record<string, [string, string]> = {
    ready: ['就绪', 'Ready'],
    connected: ['已连接', 'Connected'],
    starting: ['连接中', 'Connecting'],
    connecting: ['连接中', 'Connecting'],
    reconnecting: ['重连中', 'Reconnecting'],
    failed: ['连接失败', 'Failed'],
    stopped: ['未连接', 'Disconnected'],
    closed: ['未连接', 'Disconnected'],
  }
  return (
    <Badge
      tone={
        ['ready', 'connected'].includes(state)
          ? 'ok'
          : state === 'failed'
            ? 'bad'
            : ['starting', 'connecting', 'reconnecting'].includes(state)
              ? 'warn'
              : 'off'
      }
    >
      {labels[state]?.[zh ? 0 : 1] ?? (zh ? '读取中' : 'Loading')}
    </Badge>
  )
}
