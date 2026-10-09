import type { UINode } from '@agnes/protocol'
import { SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createAntdRoot } from '@agnes/web-ui'
import { createElement, useLayoutEffect, useSyncExternalStore } from 'react'
import type { DshNodeMount, Entry, TimelineRendererOptions } from './contracts.js'

// 与 NativeDshChildren 的子槽位清单保持一致（那边带 entryKey，这里只关心名字），
// 供「有没有人认领」判定使用；声明占位条目（key: '__agnes-native-child-declarations__'）
// 不是真实注册项，不会被 entriesOfSlot 之外的判断误伤。
export const dshChildSlotNames = (slotName: string, kind: UINode['kind']): readonly string[] =>
  slotName === 'tool.call.toolview'
    ? ['tool.call.images', 'tool.view.cordis']
    : [
        ...(kind === 'assistant' ? ['conversation.chat.assistant-actions'] : []),
        'conversation.chat.commandview',
        'conversation.chat.turnTail',
        'conversation.message.images',
        'conversation.trajectory.images',
      ]

export function mountDshNode(
  entry: Entry,
  node: UINode,
  options: Pick<TimelineRendererOptions, 'registry' | 'session' | 'locale' | 'resources'>,
): DshNodeMount | undefined {
  const registry = options.registry
  const projection = dshProjection(node)
  if (!registry || !projection || !registry.spec(projection.slotName)) return undefined

  const native = document.createElement('div')
  native.dataset.agnesTimelineNative = '1'
  while (entry.element.firstChild) native.append(entry.element.firstChild)
  entry.element.append(native)

  const host = document.createElement('div')
  host.dataset.agnesDshSlot = projection.slotName
  entry.element.append(host)
  const childHost = document.createElement('div')
  childHost.dataset.agnesDshChildren = projection.slotName
  native.append(childHost)
  const root = createAntdRoot(host)
  const childRoot = createAntdRoot(childHost)

  // 流式期间每个 delta 都会走到 update()。没有任何插件认领本节点或其子槽位时，
  // 两遍 root.render 是无产出的 reconcile——原生内容才是显示者。此时跳过 React，
  // 只监听注册表变化；一旦出现认领方（或认领方撤离），用最新节点补一次完整渲染。
  // 认领口径与 ChatNodeOutlet 的 active 相同：父槽位按 entryKey 命中，或任一子槽位有注册项。
  let latest = node
  const isClaimed = (next: UINode): boolean => {
    const nextProjection = dshProjection(next)
    if (!nextProjection) return false
    if (
      registry
        .entriesOfSlot(nextProjection.slotName)
        .some((item) => item.options.key === nextProjection.entryKey)
    )
      return true
    return dshChildSlotNames(nextProjection.slotName, next.kind).some(
      (name) => registry.entriesOfSlot(name).length > 0,
    )
  }
  let claimed = isClaimed(node)
  const render = (next: UINode): void => {
    const nextProjection = dshProjection(next)
    if (!nextProjection) return
    host.dataset.agnesDshSlot = nextProjection.slotName
    childHost.dataset.agnesDshChildren = nextProjection.slotName
    childRoot.render(
      createElement(
        SlotsProvider,
        {
          registry,
          ...(options.session ? { session: options.session } : {}),
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
        },
        createElement(NativeDshChildren, {
          projection: nextProjection,
        }),
      ),
    )
    root.render(
      createElement(
        SlotsProvider,
        {
          registry,
          ...(options.session ? { session: options.session } : {}),
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.resources ? { resources: options.resources } : {}),
        },
        createElement(ChatNodeOutlet, {
          registry,
          slotName: nextProjection.slotName,
          entryKey: nextProjection.entryKey,
          props: nextProjection.props,
          onActive(active: boolean) {
            native.hidden = active
            host.hidden = !active
          },
        }),
      ),
    )
  }
  const sync = (): void => {
    const active = isClaimed(latest)
    if (active || claimed) render(latest)
    if (active !== claimed) {
      native.hidden = active
      host.hidden = !active
    }
    claimed = active
  }
  const stops = [projection.slotName, ...dshChildSlotNames(projection.slotName, node.kind)].map((name) =>
    registry.subscribeBatched(name, sync),
  )
  if (!claimed) {
    native.hidden = false
    host.hidden = true
  } else render(node)
  return {
    update(next) {
      latest = next
      if (claimed) render(next)
    },
    dispose() {
      for (const stop of stops) stop()
      // A reset can run inside another root's commit (the transcript is torn down on a session
      // switch), where React cannot unmount a root synchronously; let that commit finish first.
      for (const nested of [root, childRoot]) queueMicrotask(() => nested.unmount())
      host.remove()
      native.remove()
    },
  }
}

export function NativeDshChildren({
  projection,
}: {
  projection: ReturnType<typeof dshProjection>
}): ReturnType<typeof createElement> {
  if (!projection) return createElement('div')
  const props = projection.props
  const owner = props.owner
  const isAssistant =
    typeof owner === 'object' && owner !== null && 'kind' in owner && owner.kind === 'assistant'
  const slots =
    projection.slotName === 'tool.call.toolview'
      ? [
          { name: 'tool.call.images' as const },
          { name: 'tool.view.cordis' as const, entryKey: projection.entryKey },
        ]
      : [
          ...(isAssistant ? [{ name: 'conversation.chat.assistant-actions' as const }] : []),
          { name: 'conversation.chat.commandview' as const, entryKey: projection.entryKey },
          { name: 'conversation.chat.turnTail' as const },
          { name: 'conversation.message.images' as const },
          { name: 'conversation.trajectory.images' as const },
        ]
  return createElement(
    'div',
    { 'data-agnes-dsh-child-outlets': projection.slotName },
    ...slots.map((slot) =>
      createElement(SlotOutlet, {
        key: slot.name,
        name: slot.name,
        ...(slot.entryKey === undefined ? {} : { entryKey: slot.entryKey }),
        props,
        hideWhenEmpty: true,
      }),
    ),
  )
}

export function dshProjection(
  node: UINode,
):
  | { slotName: 'conversation.chat.node'; entryKey: string; props: Record<string, unknown> }
  | { slotName: 'tool.call.toolview'; entryKey: string; props: Record<string, unknown> }
  | undefined {
  if (node.kind === 'tool') {
    return {
      slotName: 'tool.call.toolview',
      entryKey: node.name,
      props: {
        owner: {
          callId: node.toolUseId,
          toolName: node.name,
          block: node,
        },
      },
    }
  }
  return {
    slotName: 'conversation.chat.node',
    entryKey: node.kind,
    props: { owner: { node, nodeId: node.id, kind: node.kind } },
  }
}

export function ChatNodeOutlet({
  registry,
  slotName,
  entryKey,
  props,
  onActive,
}: {
  registry: SlotRegistry
  slotName: 'conversation.chat.node' | 'tool.call.toolview'
  entryKey: string
  props: Record<string, unknown>
  onActive(active: boolean): void
}): ReturnType<typeof createElement> {
  const version = useSyncExternalStore(
    (listener) => registry.subscribeBatched(slotName, listener),
    () => registry.getVersion(slotName),
  )
  void version
  const active = registry.entriesOfSlot(slotName).some((entry) => entry.options.key === entryKey)
  useLayoutEffect(() => {
    onActive(active)
  }, [active, onActive])
  return createElement(SlotOutlet, {
    name: slotName,
    entryKey,
    props,
    hideWhenEmpty: true,
  })
}
