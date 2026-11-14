// The Feishu Source on a dedicated bot on a real daemon: the shipped payload claims the whole channel instance A, so a
// group @ and a direct message there both become tickets answered through A; the owner's paired direct chat on
// instance B still reaches its service with a receipt; and once Superagent is disabled, A routes as before.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelTargetEvent } from '@agnes/extension-api'
import type { DecisionHandle } from '@agnes/protocol'
import { afterAll, expect, it } from 'vitest'
import { key } from '../../src/core/index.js'
import { stopAllDaemons } from '../fixtures/daemon-harness.js'
import { DESK_PACKAGE, writeDeskPlugin } from '../fixtures/desk-plugin.js'
import {
  acceptRequest,
  type Bootstrapped,
  bootstrap,
  groupMessage,
  INSTANCE,
  sleep,
  until,
} from '../fixtures/feishu-world.js'

afterAll(stopAllDaemons)

const B = 'feishu-b'
const PLUGIN = 'ext:acme/test-chat/main'
/** The owner's direct message on an instance, from someone who is not on Superagent's list. */
const ownerDm = (id: string, text: string) =>
  groupMessage(id, { text, chat: 'oc_owner', direct: true, sender: 'ou_owner' })

/** Whether a channel sent the confirmation of a pairing. */
const confirmed = (sent: { message: { blocks: { kind: string; markdown?: string }[] } }[]) =>
  sent.some((row) => row.message.blocks.some((block) => block.markdown?.startsWith('已与')))
/** Mints a pairing code of `instanceId` for the desk, approving it once, and returns the code. */
async function mintCode(world: Bootstrapped, instanceId: string): Promise<string> {
  const pairing = (params: Record<string, unknown>) =>
    world.client().request('_agnes/v1/channels.pairing', params as never) as Promise<{
      receipt?: { state: string }
      code?: string
      targets?: { owner: string; service: string; packageId: string }[]
    }>
  let listed: unknown
  const target = await until('the desk target', async () => {
    const { targets } = await pairing({ action: 'targets' })
    listed = targets
    return targets?.find((row) => row.packageId === DESK_PACKAGE)
  }).catch(async (error: unknown) => {
    const status = await world
      .client()
      .request('_agnes/v1/pluginRuntime.status', { packageId: DESK_PACKAGE } as never)
      .then(
        (value) => JSON.stringify(value).slice(0, 2000),
        (failure: unknown) => `status refused: ${JSON.stringify(failure)}`,
      )
    const lines = world.daemon
      .stderr()
      .split('\n')
      .filter((line) => /desk|managed|target|acme|fail|error|refus|denied/i.test(line))
    throw new Error(
      `${String(error)}; desk ${status}; targets ${JSON.stringify(listed)}\n${lines.slice(-60).join('\n')}`,
    )
  })
  const catalog = (await world.client().request('_agnes/v1/channels.catalog', {} as never)) as {
    providers: { extension: string; rowId: string }[]
  }
  const extension = catalog.providers.find((row) => row.rowId === PLUGIN)?.extension
  const operationId = `mint-${randomUUID()}`
  const mint = () =>
    pairing({
      action: 'mint',
      extension,
      instanceId,
      target: { owner: target.owner, service: 'desk' },
      operationId,
    })
  await until(`the minting of ${instanceId}`, async () => {
    try {
      return await mint()
    } catch (error) {
      if (JSON.stringify(error).includes('CHANNEL_UNAVAILABLE')) return undefined
      throw error
    }
  })
  const { decisions } = (await world.client().request('_agnes/v1/profile.decisions.list', {} as never)) as {
    decisions: { handle: DecisionHandle; revision: number }[]
  }
  const [decision] = decisions
  if (!decision) throw new Error('no pairing decision was listed')
  await world.client().request('_agnes/v1/profile.decisions.answer', {
    handle: decision.handle,
    revision: decision.revision,
    commandId: randomUUID(),
    response: { option: 'allowed-once', value: null },
  } as never)
  const minted = await mint()
  if (!minted.code) throw new Error(`no code was minted: ${JSON.stringify(minted)}`)
  return minted.code
}

it.skipIf(process.platform === 'win32')(
  'claims instance A whole for group and direct messages, leaves the paired direct chat on B alone, and gives A back when disabled',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-feishu-instance-e2e-')))
    let world: Bootstrapped | undefined
    try {
      world = await bootstrap(root, {
        reads: true,
        channel: INSTANCE,
        others: [B],
        feishu: {
          instance: `${PLUGIN}/${INSTANCE}`,
          claim: 'instance',
          chats: [{ chatId: 'oc_team', listen: 'mentions' }],
        },
      })
      const current = world
      const desk = writeDeskPlugin(join(root, 'desk-plugin'))
      await current.install(desk.directory)
      const a = current.chat
      const b = current.chat.of(B)

      // The owner pairs a direct chat of B with the desk; its messages reach the desk with a receipt.
      b.emit(ownerDm('om_code_b', await mintCode(current, B)), false)
      await until('the pairing on B', () => confirmed(b.sent()))
      b.emit(ownerDm('om_b1', 'hello desk'), false)
      const paired = await until('the paired message on B', () =>
        desk.events().find((event) => event.kind === 'message' && event.text === 'hello desk'),
      )
      expect(paired).toMatchObject({ instanceId: B, receiptId: expect.any(String) })

      await until(
        'the whole-instance claim',
        () =>
          current.feishuHealth().feishu?.detail === `Receiving every chat and direct message of ${INSTANCE}`,
      )
      // A group @ and a direct message of someone on the list, both on A: each becomes a ticket answered through A.
      a.emit(groupMessage('om_g1', { text: '@Superagent please fix the login page', mentioned: true }))
      a.emit(groupMessage('om_d1', { text: 'please fix the signup page', chat: 'oc_alice', direct: true }))
      await acceptRequest(current, 'om_g1')
      await acceptRequest(current, 'om_d1')
      const sent = await until('both acknowledgements on A', () =>
        a.sent().length >= 2 ? a.sent() : undefined,
      )
      expect(
        sent.map((row) => [row.target.chatType, row.target.chatId, row.message.replyTo?.messageId]).sort(),
      ).toEqual([
        ['dm', 'oc_alice', 'om_d1'],
        ['group', 'oc_team', 'om_g1'],
      ])
      // B's paired chat is untouched: the desk gets the next message with a receipt; Superagent never sees it.
      b.emit(ownerDm('om_b2', 'still the desk'), false)
      const again = await until('the second paired message on B', () =>
        desk.events().find((event) => event.kind === 'message' && event.text === 'still the desk'),
      )
      expect(again).toMatchObject({ instanceId: B, receiptId: expect.any(String) })
      expect(current.triggers().sort()).toEqual([key('feishu', 'om_d1'), key('feishu', 'om_g1')])
      expect(b.sent().every((row) => !row.message.replyTo)).toBe(true)

      // Disabled, Superagent's claim ends: A pairs and routes a direct chat as any instance does.
      await current.disable()
      await current.client().request('_agnes/v1/channels.pairing', {
        action: 'revoke',
        pairingId: (paired as ChannelTargetEvent).pairingId,
      } as never)
      a.emit(ownerDm('om_code_a', await mintCode(current, INSTANCE)), false)
      await until('the pairing on A', () => confirmed(a.sent()))
      a.emit(ownerDm('om_a1', 'hello from A'), false)
      const routed = await until('the paired message on A', () =>
        desk.events().find((event) => event.kind === 'message' && event.text === 'hello from A'),
      )
      expect(routed).toMatchObject({ instanceId: INSTANCE, receiptId: expect.any(String) })
      await sleep(500)
      expect(a.sent().filter((row) => row.message.replyTo)).toHaveLength(2)
    } catch (error) {
      throw new Error(`${String(error)}\n${(await world?.diagnostics()) ?? ''}`)
    } finally {
      await world?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  480_000,
)
