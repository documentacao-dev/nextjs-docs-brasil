/* eslint-disable @typescript-eslint/no-unused-vars */

/// <reference path="./runtime-base.ts" />
/// <reference path="../../shared/runtime/dev-extensions.ts" />
/// <reference path="../../shared/runtime/hmr-runtime.ts" />

/**
 * Development Node.js runtime.
 * Uses HotModule and shared HMR logic for hot module replacement support.
 */

// this is read in runtime-utils.ts so it creates a module with direction for hmr
createModuleWithDirectionFlag = true

if (!globalThis.__turbopack_runtime_modules__) {
  globalThis.__turbopack_runtime_modules__ = new Set()
}
runtimeModules = globalThis.__turbopack_runtime_modules__

interface TurbopackNodeDevBuildContext extends TurbopackBaseContext<HotModule> {
  R: ResolvePathFromModule
  x: ExternalRequire
  y: ExternalImport
  C: typeof clearChunkCache
}

const nodeDevContextPrototype =
  Context.prototype as TurbopackNodeDevBuildContext

nodeDevContextPrototype.q = exportUrl
nodeDevContextPrototype.c = moduleCache
nodeDevContextPrototype.R = resolvePathFromModule
nodeDevContextPrototype.C = clearChunkCache

markDevModulesLoaded = true

/**
 * Which code the factories of this runtime run, for server HMR to compare with
 * the current code of the modules. Registered by `dev-nodejs.ts`.
 */
const serverHmrRuntimeState: ServerHmrRuntimeState = {
  installedHash: new Map(),
  enteredEntries: new Set(),
  installCount: 0,
}

/** Records that `id` received a factory running the code with `hash`. */
function recordInstalledFactory(id: ModuleId, hash: string | null) {
  serverHmrRuntimeState.installedHash.set(id, hash)
  serverHmrRuntimeState.installCount++
}

/**
 * The hash of the code every known factory runs, by the module ids it was
 * listed under. Shared by all runtimes of the process, since each factory is
 * a distinct function.
 */
function getFactoryHashes() {
  return (globalThis.__turbopack_factory_hashes__ ??= new WeakMap())
}

/** Registers the factories of a development chunk, which carry hashes. */
globalThis.__turbopack_register_module_hashes__ = (chunkModules, hashes) => {
  const hashesById = new Map(hashes)
  const factoryHashes = getFactoryHashes()
  // See `installCompressedModuleFactories` for the format: module ids followed
  // by their factory, optionally preceded by a nested array.
  const visit = (modules: CompressedModuleFactories) => {
    let ids: ModuleId[] = []
    for (const item of modules) {
      if (Array.isArray(item)) {
        visit(item as CompressedModuleFactories)
      } else if (typeof item === 'function') {
        const factoryHashesById = new Map<ModuleId, string>()
        for (const id of ids) {
          const hash = hashesById.get(id)
          if (hash !== undefined) factoryHashesById.set(id, hash)
        }
        factoryHashes.set(item, factoryHashesById)
        ids = []
      } else {
        ids.push(item as ModuleId)
      }
    }
  }
  visit(chunkModules)
}

// Records which code every factory this runtime installs runs, in the same
// step that installs it: for chunks (where the first factory wins, or an id
// reuses the existing factory of its group) and for HMR updates (after the
// replaced modules were disposed, before any module runs the new factory). A
// factory runs unknown code for ids it wasn't registered under.
const installModuleFactory = moduleFactories.set.bind(moduleFactories)
moduleFactories.set = (id, factory) => {
  installModuleFactory(id, factory)
  recordInstalledFactory(id, getFactoryHashes().get(factory)?.get(id) ?? null)
  return moduleFactories
}

function interceptDevModuleExecution(
  _module: HotModule
): (() => void) | undefined {
  // There are no react refresh hooks server side so this is a no-op
  return undefined
}

function createDevModuleContext(
  module: HotModule,
  exports: Exports,
  _intercepted: boolean
): TurbopackBaseContext<HotModule> {
  return new (Context as any as ContextConstructor<HotModule>)(module, exports)
}

/**
 * Instantiates a runtime module in development mode.
 */
function instantiateRuntimeModule(
  chunkPath: ChunkPath,
  moduleId: ModuleId
): HotModule {
  return instantiateModule(moduleId, SourceType.Runtime, chunkPath)
}

/**
 * Retrieves a module from the cache, or instantiate it as a runtime module if it is not cached.
 */
// @ts-ignore TypeScript doesn't separate this module space from the browser runtime
function getOrInstantiateRuntimeModule(
  chunkPath: ChunkPath,
  moduleId: ModuleId
): HotModule {
  return (
    getCachedModule(moduleCache, moduleId) ??
    instantiateRuntimeModule(chunkPath, moduleId)
  )
}

/**
 * Retrieves a module from the cache, or instantiate it if it is not cached.
 * Also tracks parent-child relationships for HMR dependency tracking.
 */
// @ts-ignore
function getOrInstantiateModuleFromParent(
  id: ModuleId,
  sourceModule: HotModule
): HotModule {
  // Track parent-child relationship, even when the cached module errored
  trackModuleImport(sourceModule, id, moduleCache.get(id))

  const module = getCachedModule(moduleCache, id)
  if (module) {
    return module
  }

  const newModule = instantiateModule(id, SourceType.Parent, sourceModule.id)

  // Track again after instantiation to ensure the relationship is recorded
  trackModuleImport(sourceModule, id, newModule)

  return newModule
}

module.exports = (sourcePath: ChunkPath) => {
  serverHmrRuntimeState.enteredEntries.add(sourcePath)
  return {
    m: (id: ModuleId) => getOrInstantiateRuntimeModule(sourcePath, id),
    c: (chunkData: ChunkData) => loadRuntimeChunk(sourcePath, chunkData),
  }
}
