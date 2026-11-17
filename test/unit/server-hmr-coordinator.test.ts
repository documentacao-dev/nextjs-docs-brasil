import fs from 'fs'
import os from 'os'
import path from 'path'
import { setupServerHmr } from 'next/dist/server/dev/server-hmr'

type ModuleId = string | number
type RuntimeState = {
  installedHash: Map<ModuleId, string | null>
  enteredEntries: Set<string>
  installCount: number
}
type Project = Parameters<typeof setupServerHmr>[0]
type RouteChunk = {
  path: string
  versionId: string
  hashes: [ModuleId, string][]
}

const g = globalThis as any

/** A fake project that reports `route` and returns `code` for its modules. */
function fakeProject({
  route,
  code,
  onModules,
}: {
  route: () => { entryChunkPaths: string[]; chunks: RouteChunk[] }
  code: (id: ModuleId, attempt: number) => { code: string; hash: string }
  onModules?: (attempt: number) => void
}) {
  let attempts = 0
  const project: Project & { codeQueries: () => number } = {
    codeQueries: () => attempts,
    async getServerHmrRoute() {
      return { value: route(), issues: [], diagnostics: [] } as any
    },
    async getServerHmrModules(_entryPaths, request) {
      const attempt = attempts++
      onModules?.(attempt)
      const versions = new Map(
        route().chunks.map((chunk) => [chunk.path, chunk.versionId])
      )
      return {
        value: request.map(({ chunkPath, ids }) => ({
          chunkPath,
          versionId: versions.get(chunkPath)!,
          missing: [],
          entries: ids.map((id) => [
            id,
            { ...code(id, attempt), url: `${chunkPath}?${id}` },
          ]),
        })),
        issues: [],
        diagnostics: [],
      } as any
    },
  }
  return project
}

function setup(project: Project) {
  const recover = jest.fn()
  const hmr = setupServerHmr(project, {
    reEvaluateAllModulesExpensive: recover,
    onApplied: () => {},
  })
  return { hmr, recover }
}

describe('server HMR coordinator', () => {
  afterEach(() => {
    delete g.__turbopack_server_hmr_runtimes__
    delete g.__turbopack_server_hmr_apply__
  })

  describe('with a fake runtime', () => {
    let state: RuntimeState
    let applied: { dir: string; ids: string[] }[]
    beforeEach(() => {
      state = {
        installedHash: new Map([['shared', '1']]),
        enteredEntries: new Set(['entry/a.js']),
        installCount: 1,
      }
      g.__turbopack_server_hmr_runtimes__ = new Map([['server/chunks', state]])
      applied = []
      // Applies an update to the runtime of its chunks' directory, like the
      // HMR handlers of the runtimes do.
      g.__turbopack_server_hmr_apply__ = (update: any) => {
        const dirs = new Set(
          Object.keys(update.instruction.chunks).map((chunkPath) =>
            chunkPath.slice(0, chunkPath.lastIndexOf('/'))
          )
        )
        if (dirs.size !== 1) {
          throw new Error('an update must be routed to one runtime')
        }
        const [dir] = dirs
        const runtime: RuntimeState =
          g.__turbopack_server_hmr_runtimes__.get(dir)
        const ids = Object.keys(update.instruction.entries).sort()
        applied.push({ dir, ids })
        for (const id of ids) {
          runtime.installedHash.set(id, update.instruction.entries[id].hash)
          runtime.installCount++
        }
      }
    })

    const route = () => ({
      entryChunkPaths: ['entry/b.js'],
      chunks: [
        {
          path: 'server/chunks/b.js',
          versionId: 'v2',
          hashes: [
            ['shared', '2'],
            ['dep', '3'],
          ] as [ModuleId, string][],
        },
      ],
    })
    const hashes: Record<string, string> = { shared: '2', dep: '3' }

    it('does not apply an update planned before a runtime installed a factory', async () => {
      const project = fakeProject({
        route: () => route(),
        code: (id) => ({ code: `/* ${id} */`, hash: hashes[id] }),
        onModules: (attempt) => {
          if (attempt === 0) {
            // A chunk loads while the code is read.
            state.installedHash.set('other', '9')
            state.installCount++
          }
        },
      })
      const { hmr, recover } = setup(project)
      await hmr.apply(['b.js'])
      expect(recover).not.toHaveBeenCalled()
      // The first plan is dropped, and the update is planned again.
      expect(project.codeQueries()).toBe(2)
      expect(applied).toEqual([
        { dir: 'server/chunks', ids: ['dep', 'shared'] },
      ])
    })

    it('does not apply an update planned before a runtime appeared', async () => {
      const ssr: RuntimeState = {
        installedHash: new Map([['x', '1']]),
        enteredEntries: new Set(),
        installCount: 1,
      }
      const project = fakeProject({
        route: () => ({
          entryChunkPaths: ['entry/b.js'],
          chunks: [
            {
              path: 'server/chunks/b.js',
              versionId: 'v2',
              hashes: [
                ['shared', '2'],
                ['dep', '3'],
              ],
            },
            {
              path: 'server/chunks/ssr/b.js',
              versionId: 'w2',
              hashes: [['x', '2']],
            },
          ],
        }),
        code: (id) => ({
          code: `/* ${id} */`,
          hash: id === 'x' ? '2' : hashes[id],
        }),
        onModules: (attempt) => {
          // The runtime of the other directory loads while the code is read.
          if (attempt === 0) {
            g.__turbopack_server_hmr_runtimes__.set('server/chunks/ssr', ssr)
          }
        },
      })
      const { hmr, recover } = setup(project)
      await hmr.apply(['b.js'])
      expect(recover).not.toHaveBeenCalled()
      expect(project.codeQueries()).toBe(2)
      // The re-planned update includes the outdated module of the new runtime.
      expect(applied).toEqual([
        { dir: 'server/chunks', ids: ['dep', 'shared'] },
        { dir: 'server/chunks/ssr', ids: ['x'] },
      ])
      expect(ssr.installedHash.get('x')).toBe('2')
      expect(state.installedHash.has('x')).toBe(false)
    })

    it('does not apply an update planned before the route started', async () => {
      // Nothing of the route is outdated in this directory, and its route
      // didn't start, so it needs nothing until its entry starts.
      state.installedHash.set('shared', '2')
      const ssr: RuntimeState = {
        installedHash: new Map([['x', '1']]),
        enteredEntries: new Set(),
        installCount: 1,
      }
      g.__turbopack_server_hmr_runtimes__.set('server/chunks/ssr', ssr)
      const project = fakeProject({
        route: () => ({
          entryChunkPaths: ['entry/b.js'],
          chunks: [
            {
              path: 'server/chunks/b.js',
              versionId: 'v2',
              hashes: [
                ['shared', '2'],
                ['dep', '3'],
              ],
            },
            {
              path: 'server/chunks/ssr/b.js',
              versionId: 'w2',
              hashes: [['x', '2']],
            },
          ],
        }),
        code: (id) => ({
          code: `/* ${id} */`,
          hash: id === 'x' ? '2' : hashes[id],
        }),
        onModules: (attempt) => {
          // Its entry starts while the code of the other directory is read.
          if (attempt === 0) state.enteredEntries.add('entry/b.js')
        },
      })
      const { hmr, recover } = setup(project)
      await hmr.apply(['b.js'])
      expect(recover).not.toHaveBeenCalled()
      expect(project.codeQueries()).toBe(2)
      // The re-planned update installs the missing dependency of the started
      // route, and the outdated module of the other runtime.
      expect(applied).toEqual([
        { dir: 'server/chunks', ids: ['dep'] },
        { dir: 'server/chunks/ssr', ids: ['x'] },
      ])
    })

    it('does not apply code whose hash differs from the planned one', async () => {
      const project = fakeProject({
        route: () => route(),
        // The first read observes a newer execution.
        code: (id, attempt) => ({
          code: `/* ${id} */`,
          hash: attempt === 0 && id === 'shared' ? '7' : hashes[id],
        }),
      })
      const { hmr, recover } = setup(project)
      await hmr.apply(['b.js'])
      expect(recover).not.toHaveBeenCalled()
      expect(project.codeQueries()).toBe(2)
      expect(applied).toEqual([
        { dir: 'server/chunks', ids: ['dep', 'shared'] },
      ])
      expect(state.installedHash.get('shared')).toBe('2')
    })
  })

  describe('with the development Node.js runtime', () => {
    const runtimePath = path.join(
      __dirname,
      '../../turbopack/crates/turbopack-tests/tests/snapshot/debug-ids/node/output/[turbopack]_runtime.js'
    )
    let tempDir: string
    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-hmr-'))
      delete g.__turbopack_server_hmr_handlers__
      jest.resetModules()
    })
    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      delete g.__turbopack_server_hmr_handlers__
    })

    it('installs the new dependency of a self-accepted module for a route that did not start', async () => {
      const createRuntime = require(runtimePath)
      const dir = Array.from<[string, RuntimeState]>(
        g.__turbopack_server_hmr_runtimes__
      ).at(-1)![0]
      const runtime = createRuntime('entry/a.js')
      const chunk = path.join(tempDir, 'a.js')
      fs.writeFileSync(
        chunk,
        `module.exports = ['shared', function (context, module) { module.hot.accept(); module.exports = 'v1' }, 'unmodified', function (context, module) { module.exports = {} }];
globalThis.__turbopack_register_module_hashes__?.(module.exports, [['shared', '1'], ['unmodified', '4']]);
`
      )
      runtime.c(chunk)
      expect(runtime.m('shared').exports).toBe('v1')
      const unmodified = runtime.m('unmodified').exports

      const routeChunk = `${dir}/b.js`
      const code: Record<string, { code: string; hash: string }> = {
        shared: {
          code: 'function (context, module) { module.hot.accept(); module.exports = context.r("dep") }',
          hash: '2',
        },
        dep: {
          code: 'function (context, module) { module.exports = "v2" }',
          hash: '3',
        },
      }
      const { hmr, recover } = setup(
        fakeProject({
          route: () => ({
            entryChunkPaths: ['entry/b.js'],
            chunks: [
              {
                path: routeChunk,
                versionId: 'v2',
                hashes: [
                  ['shared', '2'],
                  ['dep', '3'],
                  ['unmodified', '4'],
                ],
              },
            ],
          }),
          code: (id) => code[id],
        })
      )
      await hmr.apply(['b.js'])
      expect(recover).not.toHaveBeenCalled()
      expect(runtime.m('shared').exports).toBe('v2')
      expect(runtime.m('unmodified').exports).toBe(unmodified)
    })
  })
})
