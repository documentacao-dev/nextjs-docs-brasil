import type {
  NodeJsEcmascriptMergedUpdate,
  NodeJsPartialHmrUpdate,
  Project,
  ServerHmrModuleId,
} from '../../build/swc/types'

/**
 * Which code the module factories of a development runtime run.
 *
 * Sync with `turbopack/crates/turbopack-ecmascript-runtime/js/src/nodejs/runtime/nodejs-globals.d.ts`.
 */
interface ServerHmrRuntimeState {
  /**
   * The hash of the code of every module that has a factory, `null` when the
   * module has a factory whose code isn't known.
   */
  installedHash: Map<ServerHmrModuleId, string | null>
  /** The entry chunks (relative to the output root) that use the runtime. */
  enteredEntries: Set<string>
  /** Increments whenever a factory is installed or replaced. */
  installCount: number
}

declare global {
  /**
   * Sync with `turbopack/crates/turbopack-ecmascript-runtime/js/src/nodejs/runtime/nodejs-globals.d.ts`.
   */
  var __turbopack_server_hmr_handlers__: Map<string, unknown> | undefined
  var __turbopack_server_hmr_apply__:
    | ((update: NodeJsPartialHmrUpdate) => void)
    | undefined
  var __turbopack_server_hmr_runtimes__:
    | Map<string, ServerHmrRuntimeState>
    | undefined
}

/**
 * How often a server HMR update is planned again because the route or the
 * runtimes changed while it was computed, before falling back to
 * re-evaluating all modules.
 */
const MAX_SERVER_HMR_PULLS = 3

type ChunkEntries = NonNullable<NodeJsEcmascriptMergedUpdate['entries']>

/** The output directory of a chunk. Each directory has its own runtime. */
function chunkDir(chunkPath: string) {
  const index = chunkPath.lastIndexOf('/')
  return index === -1 ? '' : chunkPath.slice(0, index)
}

/**
 * Keeps the server runtimes up to date with the routes that run in them.
 *
 * Every route that runs in a server runtime shares its module cache, and a
 * chunk that loads keeps the factories the runtime already has. So each
 * development runtime records which code its factories run, and a pull compares
 * that with the current code of the requested route's modules. For the modules
 * of the route's chunks in the runtime of each output directory:
 * - those installed at another hash, or at unknown code, are shipped;
 * - those not installed yet are shipped if the route already started in that
 *   runtime, e.g. for a chunk it gained since its entry ran or an outdated lazy
 *   import, or if outdated modules are shipped, which may run right away and
 *   require them;
 * - otherwise nothing is needed: the route's chunks install them when they
 *   load.
 *
 * What is kept here is only a cache: the hashes of the chunks reported last,
 * and which chunks were compared with which runtime since it last installed a
 * factory. Losing it only causes extra work.
 */
export function setupServerHmr(
  project: Pick<Project, 'getServerHmrRoute' | 'getServerHmrModules'>,
  {
    reEvaluateAllModulesExpensive,
    onApplied,
    mirrorApply,
  }: {
    reEvaluateAllModulesExpensive: () => void | Promise<void>
    onApplied: (chunkPaths: string[]) => void | Promise<void>
    /** Mirrors an applied update to other processes that run the modules. */
    mirrorApply?: (update: NodeJsPartialHmrUpdate) => void
  }
) {
  let pending = Promise.resolve()
  let needsReEvaluation = false
  /** The module hashes of every chunk, by path, as last reported. */
  const chunkHashes = new Map<
    string,
    { versionId: string; hashes: Map<ServerHmrModuleId, string> }
  >()
  /** The chunks compared with a runtime that needed nothing since. */
  const compared = new WeakMap<
    ServerHmrRuntimeState,
    Map<string, { versionId: string; installCount: number; started: boolean }>
  >()

  async function recover() {
    try {
      await reEvaluateAllModulesExpensive()
      needsReEvaluation = false
    } catch (error) {
      console.error('[Server HMR] Re-evaluating modules failed:', error)
    }
  }

  /**
   * Brings the runtimes up to date with the route of `entryPaths`. Returns
   * `false` when an update could not be applied and all modules need to be
   * re-evaluated, `'stale'` when the route or the runtimes changed while the
   * update was computed, so it has to be planned again.
   */
  async function pull(entryPaths: string[]): Promise<boolean | 'stale'> {
    const knownVersionIds: Record<string, string> = {}
    for (const [path, { versionId }] of chunkHashes) {
      knownVersionIds[path] = versionId
    }
    // `issues` is intentionally dropped: endpoint writes already report
    // route-scoped issues.
    const { value: route } = await project.getServerHmrRoute(
      entryPaths,
      knownVersionIds
    )
    for (const chunk of route.chunks) {
      if (chunk.hashes) {
        chunkHashes.set(chunk.path, {
          versionId: chunk.versionId,
          hashes: new Map(chunk.hashes),
        })
      } else if (chunkHashes.get(chunk.path)?.versionId !== chunk.versionId) {
        // Its hashes were left out for a version that isn't known anymore.
        chunkHashes.delete(chunk.path)
        return 'stale'
      }
    }

    type Plan = {
      runtime: ServerHmrRuntimeState
      /** The modules to ship, by chunk path. */
      request: Map<string, ServerHmrModuleId[]>
    }
    const plans = new Map<string, Plan>()
    const runtimes = globalThis.__turbopack_server_hmr_runtimes__
    /** The runtime of every directory of the route, as planned against. */
    const observed = new Map<
      string,
      {
        runtime: ServerHmrRuntimeState | undefined
        installCount: number
        started: boolean
      }
    >()
    const chunksByDir = new Map<string, typeof route.chunks>()
    for (const chunk of route.chunks) {
      const dir = chunkDir(chunk.path)
      let dirChunks = chunksByDir.get(dir)
      if (!dirChunks) {
        dirChunks = []
        chunksByDir.set(dir, dirChunks)
      }
      dirChunks.push(chunk)
    }
    for (const [dir, dirChunks] of chunksByDir) {
      const runtime = runtimes?.get(dir)
      const started =
        runtime !== undefined &&
        route.entryChunkPaths.some((path) => runtime.enteredEntries.has(path))
      observed.set(dir, {
        runtime,
        installCount: runtime?.installCount ?? 0,
        started,
      })
      // No runtime runs the chunk's directory yet, so its chunks install
      // whatever they hold when they load.
      if (!runtime) continue
      const { installedHash } = runtime
      let comparedChunks = compared.get(runtime)
      const isCompared = (chunk: (typeof dirChunks)[number]) => {
        const previous = comparedChunks?.get(chunk.path)
        return (
          previous?.versionId === chunk.versionId &&
          previous.installCount === runtime.installCount &&
          previous.started === started
        )
      }

      // Modules the runtime holds at other code are shipped. A compared chunk
      // has none.
      let outdated = false
      for (const chunk of dirChunks) {
        if (isCompared(chunk)) continue
        for (const [id, hash] of chunkHashes.get(chunk.path)!.hashes) {
          if (installedHash.has(id) && installedHash.get(id) !== hash) {
            outdated = true
            break
          }
        }
        if (outdated) break
      }

      // Missing modules are shipped too when the route started, or when
      // outdated modules are shipped: a shipped module can run right away,
      // e.g. when it accepts itself, and require modules that are new to the
      // runtime before the route's chunks load.
      const shipMissing = started || outdated
      const request = new Map<string, ServerHmrModuleId[]>()
      if (shipMissing) {
        const shipped = new Set<ServerHmrModuleId>()
        for (const chunk of dirChunks) {
          // Compared chunks hold no outdated modules, and no missing ones of a
          // started route.
          if (!outdated && isCompared(chunk)) continue
          const ids: ServerHmrModuleId[] = []
          for (const [id, hash] of chunkHashes.get(chunk.path)!.hashes) {
            // Every module is shipped once per runtime.
            if (shipped.has(id)) continue
            if (!installedHash.has(id) || installedHash.get(id) !== hash) {
              ids.push(id)
              shipped.add(id)
            }
          }
          if (ids.length > 0) request.set(chunk.path, ids)
        }
      }
      if (request.size > 0) {
        plans.set(dir, { runtime, request })
        continue
      }
      // Nothing is needed until a chunk or the runtime changes.
      if (!comparedChunks) {
        comparedChunks = new Map()
        compared.set(runtime, comparedChunks)
      }
      for (const chunk of dirChunks) {
        comparedChunks.set(chunk.path, {
          versionId: chunk.versionId,
          installCount: runtime.installCount,
          started,
        })
      }
    }
    if (plans.size === 0) return true

    const versionIds = new Map(
      route.chunks.map((chunk) => [chunk.path, chunk.versionId])
    )
    const { value: chunkModules } = await project.getServerHmrModules(
      entryPaths,
      Array.from(plans.values()).flatMap((plan) =>
        Array.from(plan.request, ([chunkPath, ids]) => ({ chunkPath, ids }))
      )
    )
    const modulesByChunk = new Map(
      chunkModules.map((chunk) => [chunk.chunkPath, chunk])
    )

    // Nothing is applied unless the update is exactly what was planned: the
    // code must have the hashes it was planned with, and no runtime of the
    // route may have installed a factory or been replaced since. Otherwise an
    // applied update could run modules against outdated dependencies.
    const currentRuntimes = globalThis.__turbopack_server_hmr_runtimes__
    for (const [dir, { runtime, installCount, started }] of observed) {
      const current = currentRuntimes?.get(dir)
      if (
        current !== runtime ||
        (current?.installCount ?? 0) !== installCount ||
        (current !== undefined &&
          route.entryChunkPaths.some((path) =>
            current.enteredEntries.has(path)
          ) !== started)
      ) {
        return 'stale'
      }
    }
    const entriesByChunk = new Map<string, ChunkEntries>()
    for (const plan of plans.values()) {
      for (const [chunkPath, ids] of plan.request) {
        const modules = modulesByChunk.get(chunkPath)
        const expected = chunkHashes.get(chunkPath)
        if (
          !modules ||
          !expected ||
          modules.versionId !== versionIds.get(chunkPath) ||
          modules.versionId !== expected.versionId ||
          modules.missing.length > 0
        ) {
          return 'stale'
        }
        const entries: ChunkEntries = {}
        for (const [id, entry] of modules.entries) {
          if (entry.hash !== expected.hashes.get(id)) return 'stale'
          entries[id] = entry
        }
        if (ids.some((id) => !Object.hasOwn(entries, id))) return 'stale'
        entriesByChunk.set(chunkPath, entries)
      }
    }

    const applyUpdate = globalThis.__turbopack_server_hmr_apply__
    if (typeof applyUpdate !== 'function') return false
    const updatedChunkPaths: string[] = []
    for (const plan of plans.values()) {
      const entries: ChunkEntries = {}
      const chunks: NonNullable<NodeJsEcmascriptMergedUpdate['chunks']> = {}
      for (const chunkPath of plan.request.keys()) {
        Object.assign(entries, entriesByChunk.get(chunkPath))
        // Routes the update to the chunk's runtime.
        chunks[chunkPath] = { type: 'partial' }
        updatedChunkPaths.push(chunkPath)
      }
      const payload: NodeJsPartialHmrUpdate = {
        type: 'partial',
        instruction: { type: 'EcmascriptMergedUpdate', entries, chunks },
      }
      try {
        applyUpdate(payload)
      } catch {
        return false
      }
      mirrorApply?.(payload)
    }
    await onApplied(updatedChunkPaths)
    return true
  }

  function apply(entryPaths: string[]): Promise<void> {
    const applyPromise = pending.then(async () => {
      if (needsReEvaluation) {
        await recover()
        return
      }

      try {
        for (let attempt = 0; attempt < MAX_SERVER_HMR_PULLS; attempt++) {
          const result = await pull(entryPaths)
          if (result === true) return
          if (result === false) break
        }
      } catch (error) {
        console.error(
          '[Server HMR] Update failed, re-evaluating modules:',
          error
        )
      }

      needsReEvaluation = true
      await recover()
    })
    pending = applyPromise
    return applyPromise
  }

  function reset(): Promise<void> {
    const resetState = () => {
      chunkHashes.clear()
      needsReEvaluation = false
    }
    const resetPromise = pending.then(resetState, resetState)
    pending = resetPromise
    return resetPromise
  }

  return { apply, reset }
}
