import { join } from 'node:path'
import { runningPackageIdentity } from '@agnes/daemon-admin/package-actual-identity'
import { activateDefaultHelpers, refreshDefaultHelpers } from '@agnes/daemon-admin/packages/default-helpers'
import {
  createClientModuleRegistry,
  createPackageAdminService,
  runtimeArtifactsFromStore,
} from '@agnes/daemon-admin/packages/index'
import {
  rebuildDesiredFromInventory,
  reconcileDesiredWebRows,
} from '@agnes/daemon-foundation/composite-desired'
import type { PublishChildEngines } from '@agnes/daemon-rpc/local/methods/config'
import { coordinateSurfacesOnBoot } from '@agnes/daemon-surfaces/surfaces/boot-coordination'
import {
  composeSecrets,
  compositionSurfaceAllowed,
  createSecretsEnv,
  createSecretsFile,
  overlayChildEngineTarget,
} from '@agnes/host'
import { activeRuntimePinId, isRuntimePackageEligible, releaseChildEngineOwner } from '@agnes/package-manager'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { HARNESS_VERSION } from '@agnes/protocol'
import type { DispatchState } from './assembly-client-dispatch.js'
import type { AssemblyLifetime } from './assembly-lifetime.js'
import type { AssemblyBase } from './assembly-options.js'
import { secretsDirectory } from './assembly-secrets.js'
import type { StoresState } from './assembly-stores.js'
import type { WorkersState } from './assembly-workers.js'
import { describeGenerationSessions } from './generation-sessions.js'
import { readRunningGenerationStatus } from './generation-status-read.js'
import { createProfileSurfaceController } from './profile-surfaces.js'
import {
  type CompositeRuntimeDelivery,
  deliverDesiredToWorkers,
} from './publication/composite-runtime-delivery.js'
import {
  createCompositeReferenceFacts,
  createCompositeRuntimePins,
  createCompositeTargetActivation,
} from './publication/composite-target-activation.js'
import { createTargetReverter } from './publication/composite-target-revert.js'
import { createRuntimePinCoordinator } from './publication/runtime-pin-coordinator.js'
import { publishProbedRuntimeTarget } from './publication/runtime-target-publisher.js'

const DAEMON_SURFACE_API_VERSION = '1.0.0'
export async function initializeRuntime(
  state: AssemblyBase & StoresState & WorkersState & DispatchState,
  lifetime: AssemblyLifetime,
) {
  const {
    o,
    composition,
    ownerHome,

    runtimeStore,

    pool,

    hostFacade,
    services,
    dispatchClientEffect,
  } = state
  if (o.packageRuntime) {
    const packageRuntime = o.packageRuntime
    const surfaces = await openRuntimeSurfaces({ ...state, packageRuntime }, lifetime)
    const activation = await openRuntimeActivation({ ...state, packageRuntime, ...surfaces }, lifetime)
    const { pluginTreePublisher } = createRuntimePublisher(
      { ...state, packageRuntime, ...surfaces, ...activation },
      lifetime,
    )
    const { surfaceController, pinCoordinator, publishChildEngines } = surfaces
    const { compositeActivation, compositePins, revertFailedDesired, localPluginWatcher } = activation
    void revertFailedDesired?.()
    const readyPackageAdmin: NonNullable<AssemblyBase['o']['packageAdmin']> =
      o.packageAdmin && !packageRuntime.embeddedAdmin
        ? o.packageAdmin
        : {
            service: createPackageAdminService({
              resolveAgent: hostFacade.resolveApplicationAgent,
              authoringHome: ownerHome,
              manager: o.packageRuntime.manager,
              profileDirectory: o.packageRuntime.profileDirectory,
              operations: o.packageRuntime.operations,
              ...(o.packageRuntime.catalog ? { catalog: o.packageRuntime.catalog } : {}),
              ...(compositeActivation ? { activation: compositeActivation } : {}),
              ...(compositePins ? { runtimePins: compositePins } : {}),
              ...(runtimeStore ? { pluginTree: runtimeStore } : {}),
              ...(pluginTreePublisher ? { pluginTreePublisher } : {}),
              ...(pinCoordinator ? { revokeRuntimePackage: pinCoordinator.revokePackage } : {}),
              workerGeneration: () => pool.businessWorker()?.generation,
              clientServiceCall: async (input) => {
                return await services.dispatchClientService(input)
              },
              clientEffectCall: async (input, authority) => {
                return await dispatchClientEffect(input, authority)
              },
              clientModules: createClientModuleRegistry({
                composition: () => composition,
                snapshotDirectory: (profile) =>
                  join(
                    packageRuntime.clientModulesDirectory ??
                      join(o.config.dataDir, 'daemon', 'client-modules'),
                    profile,
                  ),
                runtimeArtifacts: () =>
                  runtimeArtifactsFromStore(runtimeStore, pool.businessWorker()?.generation),
              }),
            }),
          }
    packageRuntime.embeddedAdmin?.initialize(readyPackageAdmin.service)
    const effectivePackageAdmin = o.packageAdmin ?? readyPackageAdmin
    return { effectivePackageAdmin, surfaceController, localPluginWatcher, publishChildEngines }
  }
  return {
    effectivePackageAdmin: o.packageAdmin,
    surfaceController: undefined,
    localPluginWatcher: undefined,
    publishChildEngines: undefined,
  }
}

export type RuntimeState = Awaited<ReturnType<typeof initializeRuntime>>

type RuntimeInput = AssemblyBase & StoresState & WorkersState & DispatchState
type PackageInput = RuntimeInput & { packageRuntime: NonNullable<AssemblyBase['o']['packageRuntime']> }

async function openRuntimeSurfaces(state: PackageInput, lifetime: AssemblyLifetime) {
  const { o, composition, notices, runtimeStore, runtimeTargetProbe, pool, packageRuntime } = state
  const packageProfileDirectory = await packageRuntime.profileDirectory(o.profile.name)
  // Surface wiring. Constructing the controller is cheap until start(); a profile that never
  // trusted a deploy directory pays nothing beyond this. Boot always coordinates surfaces.
  const surfaceSecretBackend =
    o.profile.adapters.secrets.kind === 'file'
      ? composeSecrets(createSecretsFile({ dir: secretsDirectory(o.profile, o.config) }), createSecretsEnv())
      : createSecretsEnv()
  if (packageRuntime.manager.localPluginRoots)
    await packageRuntime.manager.refreshLocalPlugins(packageProfileDirectory)
  let surfaceInventory = await packageRuntime.manager.inventory(packageProfileDirectory)
  const pinCoordinator = runtimeStore
    ? createRuntimePinCoordinator({
        store: runtimeStore,
        manager: packageRuntime.manager,
        profileDirectory: packageProfileDirectory,
      })
    : undefined
  await pinCoordinator?.recover()
  const childEngineOwner = releaseChildEngineOwner(o.profile.packages)
  const publishChildEngines: PublishChildEngines | undefined =
    runtimeStore && pinCoordinator && runtimeTargetProbe && childEngineOwner
      ? (() => {
          const store = runtimeStore
          const coordinator = pinCoordinator
          const probe = runtimeTargetProbe
          const integrity = childEngineOwner.integrity
          return async (engines) => {
            try {
              const previous = store.desired()
              if (!previous) return 'restart-required'
              const artifact = overlayChildEngineTarget(previous, engines, integrity)
              if (artifact.digest !== previous.digest) await coordinator.publish(artifact, probe)
              return 'new-sessions'
            } catch {
              return 'restart-required'
            }
          }
        })()
      : undefined
  if (runtimeStore)
    packageRuntime.references?.initialize(
      createCompositeReferenceFacts(runtimeStore, () => pool.businessWorker()?.generation),
    )
  if (runtimeStore && pinCoordinator && runtimeTargetProbe) {
    await activateDefaultHelpers({
      profileDir: o.profileDir,
      inventory: surfaceInventory,
      previous: runtimeStore.desired(),
      publish: (target) => pinCoordinator.publish(target, runtimeTargetProbe),
    })
    await refreshDefaultHelpers({
      profileDir: packageProfileDirectory,
      manager: packageRuntime.manager,
      previous: () => runtimeStore.desired(),
      publish: (target) => pinCoordinator.publish(target, runtimeTargetProbe),
    })
    surfaceInventory = await packageRuntime.manager.inventory(packageProfileDirectory)
  }
  // Bootstrap local sources through the existing pinned generation publication path.
  if (runtimeStore && pinCoordinator && runtimeTargetProbe) {
    for (const pkg of surfaceInventory.packages) {
      if (pkg.entry.source.type !== 'local' || pkg.localFailure || pkg.blockers.length) continue
      const previous = runtimeStore.desired()
      const target = rebuildDesiredFromInventory({
        previous,
        inventory: surfaceInventory,
        packageId: pkg.id,
        operation: pkg.enabled ? 'enable' : 'disable',
        configuration: (rowId) => runtimeStore.configAudit.value(pkg.id, rowId),
      })
      if (!target || target.digest === previous?.digest) continue
      try {
        await pinCoordinator.publish(target, runtimeTargetProbe)
      } catch {
        packageRuntime.manager.reportLocalPluginFailure(packageProfileDirectory, pkg.id)
      }
    }
  }
  const surfaceController = createProfileSurfaceController(
    o.profile.name,
    surfaceInventory,
    (ref) => surfaceSecretBackend.resolve(ref),
    notices,
  )
  lifetime.own({ dispose: () => surfaceController.stop() })
  await coordinateSurfacesOnBoot({
    ...(composition?.surfaces === undefined
      ? {}
      : { enabled: compositionSurfaceAllowed(composition, 'http') }),
    profileDir: o.profileDir,
    inventory: surfaceInventory,
    controller: surfaceController,
    harnessVersion: HARNESS_VERSION,
    surfaceApiVersion: DAEMON_SURFACE_API_VERSION,
    signal: new AbortController().signal,
  })

  return { packageProfileDirectory, surfaceInventory, pinCoordinator, surfaceController, publishChildEngines }
}

async function openRuntimeActivation(
  state: PackageInput & Awaited<ReturnType<typeof openRuntimeSurfaces>>,
  lifetime: AssemblyLifetime,
) {
  const {
    o,
    sessionOwnership,
    runtimeStore,
    runtimeFailure,
    runtimeWork,
    runtimeTargetProbe,
    pool,
    registry,
    lister,
    packageRuntime,
    packageProfileDirectory,
    surfaceInventory,
    pinCoordinator,
    surfaceController,
  } = state
  let latestInventory = surfaceInventory
  // Older desired artifacts predate daemon-owned web rows. Repair this narrow slice before
  // normal delivery without rewriting unrelated ordinary or resource rows.
  if (runtimeStore) {
    const repaired = reconcileDesiredWebRows({
      desired: runtimeStore.desired(),
      inventory: latestInventory,
    })
    if (repaired && repaired.digest !== runtimeStore.desired()?.digest) {
      if (runtimeTargetProbe && pinCoordinator) await pinCoordinator.publish(repaired, runtimeTargetProbe)
      else runtimeStore.publishDesired(repaired)
    }
  }
  const targetReverter = runtimeStore
    ? createTargetReverter({
        store: runtimeStore,
        loadableSnapshots: async () => {
          const [inventory, pins] = await Promise.all([
            packageRuntime.manager.inventory(packageProfileDirectory),
            packageRuntime.manager.listRuntimePins(packageProfileDirectory),
          ])
          const eligible = new Set(inventory.packages.filter(isRuntimePackageEligible).map((pkg) => pkg.id))
          return new Map(
            pins
              .filter(
                (pin) =>
                  pin.purpose === 'active' &&
                  eligible.has(pin.snapshot.packageId) &&
                  pin.pinId === activeRuntimePinId(pin.snapshot),
              )
              .map((pin) => [`${pin.snapshot.packageId}@${pin.snapshot.integrity}`, pin.snapshot.integrity]),
          )
        },
        audit: (event) => o.audit?.(event),
      })
    : undefined
  const revertFailedDesired = targetReverter
    ? () =>
        runtimeWork.run(() =>
          (pinCoordinator
            ? pinCoordinator.revert(() => targetReverter.revertFailedDesired())
            : targetReverter.revertFailedDesired()
          ).catch((error) => {
            o.audit?.({
              kind: 'worker.log',
              sessionKey: '@shared',
              level: 'warn',
              message: `reverting a failed target failed: ${error instanceof Error ? error.message : String(error)}`,
            })
          }),
        )
    : undefined
  if (revertFailedDesired) runtimeFailure.initialize(revertFailedDesired)
  const compositeActivation = runtimeStore
    ? createCompositeTargetActivation({
        store: runtimeStore,
        ...(revertFailedDesired ? { revertFailedDesired } : {}),
        settle: {
          timeoutMs: o.config.limits.workerStartupMs + 45_000,
          deliverable: () => !pool.isQuarantined('@shared'),
        },
        ...(runtimeTargetProbe ? { probe: runtimeTargetProbe } : {}),
        ...(pinCoordinator
          ? {
              publish: (target, probe, base, admission) =>
                pinCoordinator.publish(target, probe, base, undefined, admission),
            }
          : {}),
        ...(pinCoordinator ? { collectPins: pinCoordinator.collect } : {}),
        ...(pinCoordinator ? { revokePackage: pinCoordinator.revokePackage } : {}),
        ...(pinCoordinator ? { releaseRetiring: pinCoordinator.releaseRetiring } : {}),
        generationStatus: async () => {
          const status = await readRunningGenerationStatus(pool, o.config.limits.workerStartupMs)
          const running = (key: string) => registry.get(key)?.session.running === true
          return describeGenerationSessions(status, { lister, running })
        },
        publicationStatus: async () => {
          const worker = await pool.acquireSharedWorker()
          return (await worker.command(
            'pluginGenerations.publicationStatus',
            {},
            { timeoutMs: o.config.limits.workerStartupMs },
          )) as import('@agnes/protocol').PluginPublicationStatusResult
        },
        migrateSession: async (_profile, sessionId, principalId, migration) => {
          return registry.migrateGeneration(sessionId, principalId, sessionOwnership, async () => {
            const worker = await pool.acquireSharedWorker()
            // Retain the admission fence until the worker replies or exits. A command timeout
            // must not reopen admission while a durable pin write may still be running.
            return (await worker.command('pluginGenerations.migrate', {
              sessionId,
              operator: principalId,
              ...(migration?.repin ? { repin: migration.repin } : {}),
            })) as import('@agnes/protocol').SessionGenerationMigrationResult
          })
        },
        collectGenerations: async () => {
          const worker = pool.businessWorker()
          if (worker)
            await worker.link.command(
              'pluginGenerations.collect',
              {},
              { timeoutMs: o.config.limits.workerStartupMs },
            )
        },
        workerGeneration: () => pool.businessWorker()?.generation,
        workerStarting: () => pool.hasHostActivity('@shared'),
        desiredFor: async ({ packageId, operation, packageIds = [] }) => {
          latestInventory = await packageRuntime.manager.inventory(packageProfileDirectory)
          let previous = runtimeStore.desired()
          for (const member of [packageId, ...packageIds])
            previous = rebuildDesiredFromInventory({
              previous,
              inventory: latestInventory,
              packageId: member,
              operation,
              configuration: (rowId) => runtimeStore.configAudit.value(member, rowId),
            })
          return previous
        },
        contributions: (packageId) =>
          latestInventory.packages.find((pkg) => pkg.id === packageId)?.contributions,
        surfaceRunningRevision: (packageId) =>
          surfaceController
            ?.snapshot()
            .instances.find((row) => row.package === packageId && row.state === 'healthy')?.revision,
        desiredSurfaceRevision: (packageId) =>
          latestInventory.packages.find((pkg) => pkg.id === packageId)?.entry.integrity,
        packageIdentity: (packageId) => {
          const pkg = latestInventory.packages.find((row) => row.id === packageId)
          // What the worker last applied wins; the installed entry is only the fallback for a
          // package that has no plugin row in the applied target (extension-only or surface packages).
          return (
            runningPackageIdentity({ lastGood: runtimeStore.lastGood(), packageId, pkg }) ??
            (pkg ? { version: pkg.entry.version, integrity: pkg.entry.integrity } : undefined)
          )
        },
        lifecycleEligible: (packageId) => {
          const pkg = latestInventory.packages.find((row) => row.id === packageId)
          return pkg !== undefined && isRuntimePackageEligible(pkg)
        },
        deliver: (artifact) => deliverDesiredToWorkers(pool, artifact),
      })
    : undefined
  const compositePins = runtimeStore
    ? createCompositeRuntimePins({
        store: runtimeStore,
        profile: o.profile.name,
        manager: packageRuntime.manager,
        profileDirectory: packageProfileDirectory,
        ...(pinCoordinator ? { coordinator: pinCoordinator } : {}),
      })
    : undefined
  const localPluginWatcher = packageRuntime.manager.localPluginRoots
    ? (() => {
        if (compositeActivation)
          packageRuntime.manager.bindLocalPluginReload({
            async reloadPlugin(id) {
              const inventory = await packageRuntime?.manager.inventory(packageProfileDirectory)
              const plugin = inventory.packages.find((pkg) => pkg.id === id)
              if (!plugin || plugin.localFailure)
                throw new Error('E_PLUGIN_RELOAD_METADATA: local plugin is unavailable')
              const result = await compositeActivation.reconcile({
                profile: o.profile.name,
                packageId: id,
                operationId: `local-reload:${id}`,
                operation: 'update',
                signal: new AbortController().signal,
              })
              if (result.error) throw new Error(result.error.code)
            },
          })
        const watcher = packageRuntime.manager.watchLocalPlugins(packageProfileDirectory)
        lifetime.own({ stop: () => watcher.close(), dispose: () => undefined })
        return watcher
      })()
    : undefined

  return { compositeActivation, compositePins, revertFailedDesired, localPluginWatcher }
}

function createRuntimePublisher(
  state: PackageInput &
    Awaited<ReturnType<typeof openRuntimeSurfaces>> &
    Awaited<ReturnType<typeof openRuntimeActivation>>,
  _lifetime: AssemblyLifetime,
) {
  const { runtimeStore, runtimeDelivery, runtimeTargetProbe, pool, pinCoordinator, revertFailedDesired } =
    state
  const pluginTreePublisher =
    runtimeStore && runtimeTargetProbe
      ? async (artifact: RuntimeTargetArtifact, liveConfig?: boolean) => {
          await revertFailedDesired?.()
          const apply =
            liveConfig && runtimeDelivery
              ? async (target: RuntimeTargetArtifact) => {
                  const link = await pool.acquireSharedWorker().catch(() => {
                    throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                  })
                  const worker = pool.businessWorker()
                  if (!worker || worker.link !== link) throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                  const restore = async () => {
                    const current = runtimeStore.desired()
                    const worker = pool.businessWorker()
                    if (!current || !worker) throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                    const restored = await runtimeDelivery.applyBeforeCommit(worker.generation, current, () =>
                      worker.link.offerRuntimeTarget(current),
                    )
                    if (
                      !restored.report.ok ||
                      !worker.link.alive ||
                      pool.businessWorker()?.generation !== restored.generation
                    )
                      throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                  }
                  let receipt: Awaited<ReturnType<CompositeRuntimeDelivery['applyBeforeCommit']>>
                  try {
                    receipt = await runtimeDelivery.applyBeforeCommit(worker.generation, target, () =>
                      link.offerRuntimeTarget(target),
                    )
                  } catch (error) {
                    // A Host publication can fail after some composition containers applied.
                    if (error instanceof Error && error.name === 'PluginConfigRefused') {
                      try {
                        await restore()
                      } catch {
                        throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                      }
                    }
                    throw error
                  }
                  if (!link.alive || pool.businessWorker()?.generation !== receipt.generation)
                    throw new Error('E_RUNTIME_TARGET_OUTCOME_UNKNOWN')
                  return {
                    ...receipt,
                    isCurrent: () => link.alive && pool.businessWorker()?.generation === receipt.generation,
                    restore,
                  }
                }
              : undefined
          if (pinCoordinator) await pinCoordinator.publish(artifact, runtimeTargetProbe, undefined, apply)
          else
            await publishProbedRuntimeTarget({
              store: runtimeStore,
              artifact,
              probe: runtimeTargetProbe,
              ...(apply ? { apply } : {}),
            })
        }
      : undefined

  return { pluginTreePublisher }
}
