/// <reference path="../../shared/runtime/runtime-types.d.ts" />

/**
 * Global type definitions for Node.js Turbopack runtime.
 * These properties are stored on globalThis to persist across chunk reloads during HMR.
 */

declare global {
  var __turbopack_module_factories__: ModuleFactories
  var __turbopack_module_cache__: Record<ModuleId, any>
  var __turbopack_runtime_modules__: Set<ModuleId>
  /**
   * Shared registry of per-runtime server HMR handler entries, keyed by the
   * runtime file's __filename. Map.set() naturally replaces stale entries when
   * a runtime file is re-evaluated. Reset to undefined by the hot-reloader on
   * full cache reset.
   */
  // NodeJsHmrPayload is only in scope inside the concatenated runtime chunk, not
  // in this .d.ts file, so the handler parameter must use any here.

  var __turbopack_server_hmr_handlers__:
    | Map<string, { handler: (update: any) => void; chunkPrefix: string }>
    | undefined
  /**
   * Compiles an on-demand chunk before the runtime requires it.
   *  Used together with EcmascriptOptionsContext.lazy_compilation
   */
  var __turbopack_ensure_chunk__:
    | ((chunkPath: ChunkPath) => void | Promise<void>)
    | undefined
  /**
   * Which code the module factories of a development runtime run, as server
   * HMR compares it with the current code of the modules.
   */
  interface ServerHmrRuntimeState {
    /**
     * The hash of the code of every module that has a factory. `null` when
     * the module has a factory whose code isn't known. Never removed, since a
     * factory stays when its module is removed from a chunk.
     */
    installedHash: Map<ModuleId, string | null>
    /** The entry chunks (relative to the output root) that use this runtime. */
    enteredEntries: Set<ChunkPath>
    /** Increments whenever a factory is installed or replaced. */
    installCount: number
  }
  /**
   * The state of every development runtime, keyed by the output directory
   * (relative to the output root) of the chunks it serves. A runtime that
   * replaces another one registers a new state object.
   */
  var __turbopack_server_hmr_runtimes__:
    | Map<string, ServerHmrRuntimeState>
    | undefined
  /**
   * The hash of the code of development factories, by the module ids they
   * were listed under. See `dev-base.ts`.
   */
  var __turbopack_factory_hashes__:
    | WeakMap<Function, Map<ModuleId, string>>
    | undefined
  /**
   * Called by development chunks with their factories and the hash of the
   * code of each of their modules. Defined by the development runtime.
   */
  var __turbopack_register_module_hashes__:
    | ((
        chunkModules: CompressedModuleFactories,
        hashes: Array<[ModuleId, string]>
      ) => void)
    | undefined
}

export {}
