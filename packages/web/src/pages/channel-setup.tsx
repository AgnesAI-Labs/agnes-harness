import type { ProfileServiceReceipt } from '@agnes/protocol'
import { Button, Select } from '@agnes/web-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { closeChannelDialog } from './channel-dialog-state.js'
import { InstanceForm } from './channel-instance.js'
import { channelsChanged } from './channel-model.js'
import { SessionBindings } from './channel-session.js'
import type { ChannelContext, ChannelGroup, Instance, ManagedInstance } from './channel-types.js'
import type { HomePageData } from './host.js'

export function ChannelSetup({
  data,
  group,
  sessionId,
  existing,
  credentials,
  zh,
  onStage,
}: {
  data: HomePageData
  group: ChannelGroup
  sessionId: string
  existing?: ManagedInstance | undefined
  credentials: { id: string; label: string }[]
  zh: boolean
  onStage?(value: number): void
}) {
  const initial =
    existing ??
    group.instances.find(
      (item) =>
        item.bindings.some((binding) => binding.sessionId === sessionId) ||
        item.intendedSession?.sessionId === sessionId,
    )
  const [source, setSource] = useState(initial)
  const [context, setContext] = useState<ChannelContext>()
  const [value, setValue] = useState<Instance>(
    () =>
      initial ?? {
        id: '',
        workspace: '',
        agent: '',
        credentialRefs: {},
        config: {},
        allowFrom: [],
        requireMention: true,
      },
  )
  const [phase, setPhase] = useState<'configure' | 'bind'>('configure')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<Record<string, unknown>>()
  const [bound, setBound] = useState(false)
  const alive = useRef(false)
  const call = data.channelCall ?? data.call
  useEffect(() => {
    alive.current = true
    let current = true
    onStage?.(1)
    setContext(undefined)
    void call<ChannelContext>('channels.context', {
      extension: group.provider.extension,
      sessionId,
      ...(source ? { instanceId: source.id } : {}),
    })
      .then((result) => {
        if (current) {
          setContext(result)
          setValue((previous) => ({
            ...previous,
            id: result.instanceId,
            workspace: result.workspace,
            agent: result.agent,
          }))
          setMessage('')
        }
      })
      .catch(() => {
        if (current)
          setMessage(zh ? '无法读取会话，请重新打开重试。' : 'Unable to read the session. Reopen to retry.')
      })
    return () => {
      current = false
      alive.current = false
    }
  }, [call, group.provider.extension, sessionId, source, zh, onStage])
  const instanceIds = useMemo(() => (context ? [context.instanceId] : []), [context])
  const save = async () => {
    if (!context || !group.configurationRevision) return
    if (!pending && group.provider.manifest.credentials.required.some((key) => !value.credentialRefs[key])) {
      setMessage(zh ? '请选择所有必需的凭据。' : 'Choose every required credential.')
      return
    }
    const input = pending ?? {
      extension: group.provider.extension,
      sessionId,
      instanceId: context.instanceId,
      ...(source ? { replaceId: source.id } : {}),
      credentialRefs: value.credentialRefs,
      config: value.config,
      allowFrom: value.allowFrom,
      requireMention: value.requireMention,
      configurationRevision: group.configurationRevision,
      operationId: crypto.randomUUID(),
    }
    setPending(input)
    setBusy(true)
    setMessage('')
    try {
      const result = await call<{ receipt: ProfileServiceReceipt; instanceId: string }>(
        'channels.configure',
        input,
      )
      if (!alive.current) return
      if (result.receipt.state === 'completed') {
        setPending(undefined)
        setPhase('bind')
        onStage?.(2)
        channelsChanged()
      } else if (result.receipt.state === 'approval-required') {
        data.requestProfileApproval?.(result.receipt)
        setMessage(
          zh
            ? '请完成原生审批，再点击“继续连接”。'
            : 'Confirm the native approval, then Continue connecting.',
        )
      } else if (['refused', 'cancelled'].includes(result.receipt.state)) {
        setPending(undefined)
        setMessage(
          zh
            ? '连接未保存，请检查配置及审批结果。'
            : 'Connection was not saved. Check settings and approval.',
        )
      } else
        setMessage(
          zh
            ? '操作尚未确认，请继续核对同一次操作。'
            : 'Operation unconfirmed. Continue to reconcile this operation.',
        )
    } catch {
      if (alive.current)
        setMessage(
          zh
            ? '连接未确认。可继续重试；配置被其他页面修改时，请重新打开。'
            : 'Connection unconfirmed. Continue to retry; reopen if configuration changed elsewhere.',
        )
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <>
      {context && (
        <div className="channel-session-summary">
          <small>{zh ? '跟随当前会话' : 'From this session'}</small>
          <strong>{context.title}</strong>
          <span>{context.agentTitle[zh ? 'zh-CN' : 'en']}</span>
          <span title={context.workspace}>{context.workspace}</span>
        </div>
      )}
      {phase === 'configure' ? (
        <>
          {!existing && !!group.instances.length && (
            <div className="channel-reuse">
              <Select
                disabled={busy || !!pending}
                aria-label={zh ? '机器人连接' : 'Bot connection'}
                value={source?.id ?? 'new'}
                options={[
                  { value: 'new', label: zh ? '添加新的机器人连接' : 'Add a new bot connection' },
                  ...group.instances.map((item) => ({
                    value: item.id,
                    label:
                      (item.bindings[0]?.sessionTitle ?? item.intendedSession?.title ?? item.id) +
                      (item.bindings.length ? (zh ? ' · 换绑此连接' : ' · Move this connection') : ''),
                    disabled: item.unavailable,
                  })),
                ]}
                onChange={(id: string) => {
                  const next = group.instances.find((item) => item.id === id)
                  setSource(next)
                  setValue(
                    next ?? {
                      id: '',
                      workspace: '',
                      agent: '',
                      credentialRefs: {},
                      config: {},
                      allowFrom: [],
                      requireMention: true,
                    },
                  )
                }}
              />
              {source?.bindings.length ? (
                <p className="channel-muted">
                  {zh
                    ? '保存后原绑定将解除，再选择此会话的聊天对象。'
                    : 'Saving releases the old binding. Choose a chat for this session next.'}
                </p>
              ) : null}
            </div>
          )}
          {context &&
            source?.id === context.instanceId &&
            source.bindings.some((binding) => binding.sessionId === sessionId) && (
              <Button
                onClick={() => {
                  setPhase('bind')
                  onStage?.(2)
                }}
              >
                {zh ? '查看当前绑定' : 'View current binding'}
              </Button>
            )}
          <InstanceForm
            value={value}
            provider={group.provider}
            credentials={credentials}
            disabled={busy || !!pending || !context || source?.unavailable === true}
            zh={zh}
            onChange={setValue}
          />
          <div className="channel-dialog-footer">
            <Button appearance="ghost" onClick={() => data.openSettings('security')}>
              {zh ? '管理凭据' : 'Manage credentials'}
            </Button>
            <Button
              appearance="primary"
              disabled={busy || !context || !!group.error || !!source?.unavailable}
              loading={busy}
              onClick={() => void save()}
            >
              {pending
                ? zh
                  ? '继续连接'
                  : 'Continue connecting'
                : zh
                  ? '连接并继续'
                  : 'Connect and continue'}
            </Button>
          </div>
        </>
      ) : (
        context && (
          <>
            <SessionBindings
              data={data}
              provider={group.provider}
              sessionId={sessionId}
              instanceIds={instanceIds}
              refreshKey={context.instanceId}
              zh={zh}
              onChanged={() => channelsChanged()}
              onBound={setBound}
            />
            <div className="channel-dialog-footer">
              <span className="channel-muted">
                {zh ? '仅同步绑定后的新消息' : 'Only new messages are shared'}
              </span>
              <Button appearance={bound ? 'primary' : 'secondary'} onClick={closeChannelDialog}>
                {bound ? (zh ? '完成，开始聊天' : 'Done, start chatting') : zh ? '稍后绑定' : 'Bind later'}
              </Button>
            </div>
          </>
        )
      )}
      {message && (
        <p role="status" className="channel-notice">
          {message}
        </p>
      )}
    </>
  )
}
