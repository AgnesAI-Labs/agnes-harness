import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginWakeBinding } from '@agnes/host-extensions/profile/wakes'
import { rpcError } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { BoundWakeService, deliverBoundWake } from '../src/jobs/bound-wakes.js'
import { JobsRepo } from '../src/jobs/repo.js'
import { JobsService } from '../src/jobs/service.js'
import { sqliteTables } from './sqlite-tables.js'

const binding: PluginWakeBinding = {
  bindingId: 'target',
  producerOwner: 'plugin/0123456789abcdef',
  producerIntegrity: 'snapshot',
  profileId: 'default',
  activationId: 'epoch',
  sessionId: 'original',
  laneId: 'analysis',
  generationId: 'gen-one',
  actorId: 'operator',
}
const input = {
  target: { bindingId: 'target' },
  idempotencyKey: 'operation-one/result-one',
  event: { name: 'report.done', summary: 'Synthetic report finished', data: { result: 'done' } },
}

describe('durable bound notifications', () => {
  it('reuses jobs across enqueue/claim/input/settle crashes and binds the original target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agh-bound-wake-'))
    let now = 1000,
      active = true
    let tables = sqliteTables(join(directory, 'jobs.sqlite'))
    const resolve = async (bindingId: string, credential: unknown) => {
      if (credential !== 'producer' || bindingId !== binding.bindingId) throw rpcError('CAPABILITY_DENIED')
      return { binding, active }
    }
    const make = (profileHash = 'profile') => {
      const repo = new JobsRepo(tables.table('jobs'), () => now)
      return {
        repo,
        service: new BoundWakeService({ repo, profileHash, clock: () => now, resolve }),
      }
    }
    let { repo, service } = make()
    try {
      const queued = await service.enqueue(input, 'producer')
      expect(queued.state).toBe('queued')
      expect(await service.enqueue(input, 'producer')).toEqual(queued)
      await expect(
        service.enqueue({ ...input, event: { ...input.event, summary: 'Changed' } }, 'producer'),
      ).rejects.toMatchObject({ data: { reason: 'JOB_IDENTITY_CONFLICT' } })
      await expect(
        service.enqueue({ ...input, sessionId: 'forged' } as never, 'producer'),
      ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
      await expect(service.read(queued.wakeId, 'other-owner')).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      repo.claimDue(now, 'dead-owner', 10, 1)
      await tables.close()
      tables = sqliteTables(join(directory, 'jobs.sqlite'))
      ;({ repo, service } = make())
      now += 11
      repo.reclaimStalled(now, 5)
      const committed = new Map<string, number>()
      let crashAfterInput = true
      const dispatch = (job: ReturnType<JobsRepo['claimDue']>[number]) =>
        deliverBoundWake(job, new AbortController().signal, {
          requireTarget: async () => {
            if (!active) throw rpcError('CAPABILITY_DENIED')
            return binding
          },
          deliver: async (target, commandId, event) => {
            expect(target).toMatchObject({
              sessionId: 'original',
              laneId: 'analysis',
              generationId: 'gen-one',
            })
            expect(event.name).toBe('report.done')
            if (!committed.has(commandId)) committed.set(commandId, 42)
            if (crashAfterInput) {
              crashAfterInput = false
              throw new Error('lost reply after input commit')
            }
            return committed.get(commandId)!
          },
        })
      let job = repo.claimDue(now, 'first', 10, 1)[0]!
      await expect(dispatch(job)).rejects.toThrow('lost reply')
      await tables.close()
      tables = sqliteTables(join(directory, 'jobs.sqlite'))
      ;({ repo, service } = make())
      now += 11
      repo.reclaimStalled(now, 5)
      job = repo.claimDue(now, 'second', 10, 1)[0]!
      const outcome = await dispatch(job)
      expect(outcome).toMatchObject({ reason: 'delivered', seq: 42 })
      repo.settle(job.idempotencyKey, { status: 'completed', result: outcome })
      expect(committed.size).toBe(1)
      expect(await service.read(queued.wakeId, 'producer')).toMatchObject({ state: 'delivered' })
      ;({ repo, service } = make('changed-profile-settings'))
      expect(await service.enqueue(input, 'producer')).toMatchObject({ state: 'delivered' })
      active = false
      expect(await service.enqueue({ ...input, idempotencyKey: 'revoked' }, 'producer')).toMatchObject({
        state: 'refused',
      })
      expect(await service.enqueue(input, 'producer')).toMatchObject({ state: 'delivered' })
    } finally {
      await tables.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('refuses revocation at claim/delivery and never allows notification payloads through arbitrary jobs enqueue', async () => {
    const tables = sqliteTables(),
      repo = new JobsRepo(tables.table('jobs'), () => 1000)
    const service = new BoundWakeService({
      repo,
      profileHash: 'profile',
      clock: () => 1000,
      resolve: async () => ({ binding, active: true }),
    })
    try {
      const receipt = await service.enqueue(input, 'producer'),
        job = repo.get(receipt.wakeId)!
      expect(
        await deliverBoundWake(job, new AbortController().signal, {
          requireTarget: async () => {
            throw rpcError('CAPABILITY_DENIED')
          },
          deliver: async () => {
            throw new Error('must never deliver')
          },
        }),
      ).toEqual({ reason: 'refused', code: 'TARGET_REVOKED' })
      expect(
        await deliverBoundWake(job, new AbortController().signal, {
          requireTarget: async () => binding,
          deliver: async () => {
            throw rpcError('CAPABILITY_DENIED')
          },
        }),
      ).toEqual({ reason: 'refused', code: 'TARGET_REVOKED' })
      const jobs = new JobsService({ repo, profileHash: 'profile', clock: () => 1000 })
      await expect(
        jobs.enqueue(
          { idempotencyKey: 'forged', sessionKey: 'other', payload: job.payload, schedule: { kind: 'once' } },
          { local: true },
        ),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    } finally {
      await tables.close()
    }
  })
})
