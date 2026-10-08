import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { NodeClient, Session } from '@agnes/sdk'
import { expect } from './fixtures.js'

type Receipt = Awaited<ReturnType<NodeClient['packages']['install']>>
export async function complete(client: NodeClient, receipt: Receipt) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await client.packages.operation.get({
      profile: 'local-dev',
      operationId: receipt.operationId,
    })
    if (result.state === 'failed' || result.state === 'cancelled' || result.state === 'rolled-back')
      throw new Error(`Package operation ${result.state}: ${JSON.stringify(result.error)}`)
    if (result.state === 'completed') return result
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Package operation timed out: ${receipt.operationId}`)
}
export async function command(client: NodeClient) {
  return { profile: 'local-dev', clientId: await client.clientId(), commandId: randomUUID() }
}
export async function install(client: NodeClient, directory: string) {
  const source = { type: 'file' as const, ref: `file:${resolve(directory)}` }
  const { preview } = await complete(
    client,
    await client.packages.inspect({ ...(await command(client)), source }),
  )
  if (!preview?.capabilityHash) throw new Error('Inspection must return integrity and capabilities')
  expect(preview.blockers).toEqual([])
  await complete(
    client,
    await client.packages.install({
      ...(await command(client)),
      source,
      expectedIntegrity: preview.integrity,
    }),
  )
  await complete(
    client,
    await client.packages.trust({
      ...(await command(client)),
      id: preview.id,
      expectedIntegrity: preview.integrity,
      capabilityHash: preview.capabilityHash,
    }),
  )
  await complete(client, await client.packages.enable({ ...(await command(client)), id: preview.id }))
  return preview
}
export async function toolResult(session: Session, name: string) {
  const timeline = await session.projectUI(undefined, { surface: 'web' })
  const node = timeline.nodes.findLast((node) => node.kind === 'tool' && node.name === name)
  if (node?.kind !== 'tool' || node.resultSeq === undefined) throw new Error(`No durable result for ${name}`)
  const detail = await session.readToolDetail(node.seq, node.resultSeq)
  expect(detail.result?.isError, `${name}: ${JSON.stringify(detail.result?.content)}`).toBe(false)
  return detail.result
}
export async function prompt(session: Session, input: string) {
  const result = await session
    .prompt(input, { signal: AbortSignal.timeout(20_000) })
    .catch((error: unknown) => {
      const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
      throw new Error(`Prompt failed in session ${session.id}: ${JSON.stringify(data)}`, { cause: error })
    })
  expect(result.reason).toBe('completed')
  return result
}
