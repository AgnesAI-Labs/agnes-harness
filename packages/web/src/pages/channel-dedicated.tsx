import type { ProfileServiceReceipt } from '@agnes/protocol'
import { Button, Field, Select } from '@agnes/web-ui'
import { useEffect, useId, useRef, useState } from 'react'
import { closeChannelDialog } from './channel-dialog-state.js'
import { InstanceForm } from './channel-instance.js'
import { channelsChanged } from './channel-model.js'
import type { ChannelGroup, DedicatedContext, Instance } from './channel-types.js'
import type { HomePageData } from './host.js'

const blank: Instance = {
  id: '',
  workspace: '',
  agent: '',
  credentialRefs: {},
  config: {},
  allowFrom: [],
  requireMention: true,
}

/** Fixed outcome notices: [zh-CN, en]. */
const NOTICES = {
  workspaces: ['无法读取工作区，请重新打开重试。', 'Unable to read workspaces. Reopen to retry.'],
  credentials: ['请选择所有必需的凭据。', 'Choose every required credential.'],
  approval: [
    '请完成原生审批，再点击“继续创建”。',
    'Confirm the native approval, then choose Continue creating.',
  ],
  conflict: [
    '连接配置已在别处更改，本次未保存任何内容。请核对后重新创建。',
    'Connections changed elsewhere. Nothing was saved; review and create again.',
  ],
  notCreated: [
    '连接未创建，请检查配置及审批结果。',
    'Connection was not created. Check settings and approval.',
  ],
  unconfirmed: [
    '操作尚未确认，请继续核对同一次操作。',
    'Operation unconfirmed. Continue to reconcile this operation.',
  ],
  refused: [
    '无法按当前设置创建连接（例如工作区或凭据已变化），本次未保存。请核对后重试。',
    'This connection cannot be created with these settings (a workspace or credential may have changed). Nothing was saved; review and try again.',
  ],
  maybeCreated: [
    '这个连接可能已由之前未确认的尝试创建，请在连接列表中查看后再决定是否重新创建。',
    'An earlier unconfirmed attempt may already have created this connection. Check the connection list before creating it again.',
  ],
  lost: [
    '连接未确认。可继续重试同一次操作，或重新读取后重新开始。',
    'Connection unconfirmed. Continue to retry this operation, or start over with a fresh read.',
  ],
} as const

/**
 * Creates one connection that no session is bound to, for an app that takes a whole connection. The
 * server picks its identity, workspace path and agent; the flow ends once the connection exists.
 */
export function DedicatedSetup({
  data,
  group,
  credentials,
  zh,
  onRefresh,
}: {
  data: HomePageData
  group: ChannelGroup
  credentials: { id: string; label: string }[]
  zh: boolean
  onRefresh(): void
}) {
  const call = data.channelCall ?? data.call
  const id = useId()
  const [context, setContext] = useState<DedicatedContext>()
  const [workspaceId, setWorkspaceId] = useState<string>()
  const [value, setValue] = useState<Instance>(blank)
  const [pending, setPending] = useState<Record<string, unknown>>()
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState(false)
  // The last attempt failed without a receipt: its outcome is unconfirmed, so starting over is offered.
  const [failed, setFailed] = useState(false)
  // Started over after an unconfirmed attempt, which may have created the connection after all.
  const [restarted, setRestarted] = useState(false)
  const [message, setMessage] = useState('')
  const alive = useRef(false)
  const say = (key: keyof typeof NOTICES) => setMessage(NOTICES[key][zh ? 0 : 1])
  useEffect(() => {
    alive.current = true
    let current = true
    void call<DedicatedContext>('channels.dedicatedContext', { extension: group.provider.extension })
      .then((result) => {
        if (!current) return
        setContext(result)
        setWorkspaceId(result.workspaces[0]?.workspaceId)
      })
      .catch(() => {
        if (current) setMessage(NOTICES.workspaces[zh ? 0 : 1])
      })
    return () => {
      current = false
      alive.current = false
    }
  }, [call, group.provider.extension, zh])
  const workspace = context?.workspaces.find((item) => item.workspaceId === workspaceId)
  const save = async () => {
    if (!context || !workspace || !group.configurationRevision) return
    if (!pending && group.provider.manifest.credentials.required.some((key) => !value.credentialRefs[key])) {
      say('credentials')
      return
    }
    // A retry after approval resends the same operation; the server rechecks the reviewed revision.
    const input = pending ?? {
      extension: group.provider.extension,
      workspaceId: workspace.workspaceId,
      instanceId: context.instanceId,
      credentialRefs: value.credentialRefs,
      config: value.config,
      allowFrom: value.allowFrom,
      requireMention: value.requireMention,
      configurationRevision: group.configurationRevision,
      operationId: crypto.randomUUID(),
    }
    setPending(input)
    setBusy(true)
    setFailed(false)
    setMessage('')
    try {
      const { receipt } = await call<{ receipt: ProfileServiceReceipt }>('channels.configureDedicated', input)
      if (!alive.current) return
      if (receipt.state === 'completed') {
        setPending(undefined)
        setCreated(true)
        channelsChanged()
      } else if (receipt.state === 'approval-required') {
        data.requestProfileApproval?.(receipt)
        say('approval')
      } else if (receipt.state === 'refused' && receipt.code === 'REVISION_CONFLICT') {
        setPending(undefined)
        onRefresh()
        say(restarted ? 'maybeCreated' : 'conflict')
      } else if (['refused', 'cancelled'].includes(receipt.state)) {
        setPending(undefined)
        say('notCreated')
      } else say('unconfirmed')
    } catch (error) {
      if (!alive.current) return
      if ((error as { code?: unknown }).code === 'CHANNEL_REFUSED') {
        // The launcher refuses these settings as they are; the same request would be refused again.
        setPending(undefined)
        onRefresh()
        say((error as { reason?: unknown }).reason === 'exists' ? 'maybeCreated' : 'refused')
      } else {
        setFailed(true)
        say('lost')
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  if (created)
    return (
      <>
        <p role="status" className="channel-notice">
          {zh
            ? '专用连接已创建，未绑定任何会话。需要独占整个连接的应用现在可以按实例 ID 选择它。'
            : 'Dedicated connection created. No session is bound to it; an app that uses a whole connection can select it by instance ID now.'}
        </p>
        <p className="channel-muted">
          {zh ? '实例 ID：' : 'Instance ID: '}
          <code>{context?.instanceId}</code>
        </p>
        <div className="channel-dialog-footer">
          <span />
          <Button appearance="primary" onClick={closeChannelDialog}>
            {zh ? '完成' : 'Done'}
          </Button>
        </div>
      </>
    )
  return (
    <>
      <p className="channel-muted">
        {zh
          ? '新建一个暂不绑定会话的机器人连接，供需要独占整个连接的应用使用。'
          : 'Create a bot connection that is not bound to a session, for an app that uses a whole connection.'}
      </p>
      {context && (
        <div className="channel-session-summary">
          <Field label={zh ? '工作区' : 'Workspace'} htmlFor={`${id}-workspace`}>
            <Select
              id={`${id}-workspace`}
              aria-label={zh ? '工作区' : 'Workspace'}
              disabled={busy || !!pending}
              placeholder={zh ? '选择工作区' : 'Choose a workspace'}
              value={workspaceId ?? null}
              options={context.workspaces.map((item) => ({ value: item.workspaceId, label: item.name }))}
              onChange={(next: string) => setWorkspaceId(next)}
            />
          </Field>
          {workspace && <span title={workspace.path}>{workspace.path}</span>}
          <span>{context.agentTitle[zh ? 'zh-CN' : 'en']}</span>
        </div>
      )}
      {context && !context.workspaces.length && (
        <p role="alert">
          {zh ? '没有可用的工作区，请先添加工作区。' : 'No workspace is available. Add a workspace first.'}
        </p>
      )}
      <InstanceForm
        value={value}
        provider={group.provider}
        credentials={credentials}
        disabled={busy || !!pending || !context}
        zh={zh}
        onChange={setValue}
      />
      <div className="channel-dialog-footer">
        <Button appearance="ghost" onClick={() => data.openSettings('security')}>
          {zh ? '管理凭据' : 'Manage credentials'}
        </Button>
        {pending && failed && !busy && (
          <Button
            appearance="ghost"
            onClick={() => {
              // The fixed instance id keeps a fresh attempt from creating a second connection.
              setPending(undefined)
              setFailed(false)
              setRestarted(true)
              setMessage('')
              onRefresh()
            }}
          >
            {zh ? '重新开始' : 'Start over'}
          </Button>
        )}
        <Button
          appearance="primary"
          disabled={busy || !workspace || !!group.error}
          loading={busy}
          onClick={() => void save()}
        >
          {pending ? (zh ? '继续创建' : 'Continue creating') : zh ? '创建连接' : 'Create connection'}
        </Button>
      </div>
      {message && (
        <p role="status" className="channel-notice">
          {message}
        </p>
      )}
    </>
  )
}
