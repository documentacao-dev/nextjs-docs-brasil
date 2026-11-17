import { setupServerHmr } from 'next/dist/server/dev/server-hmr'
import type { NodeJsPartialHmrUpdate } from 'next/dist/build/swc/types'

// The e2e tests in `test/development/app-dir/server-hmr` cover what server HMR
// ships. These cover what they can't time: a runtime or the code changing
// while an update is computed.

type RuntimeState = {
  installedHash: Map<string, string | null>
  enteredEntries: Set<string>
  installCount: number
}
type Project = Parameters<typeof setupServerHmr>[0]
type ModuleEntry = { code: string; url: string; hash: string }

const g = globalThis as typeof globalThis & {
  __turbopack_server_hmr_runtimes__?: Map<string, RuntimeState>
  __turbopack_server_hmr_apply__?: (update: NodeJsPartialHmrUpdate) => void
}

describe('server HMR coordinator', () => {
  const hashes: Record<string, string> = { shared: '2', dep: '3' }
  let state: RuntimeState
  let applied: string[][]

  /** A project whose route holds `shared` and `dep` in one chunk. */
  function fakeProject({
    hash,
    onModules,
  }: {
    hash: (id: string, attempt: number) => string
    onModules?: (attempt: number) => void
  }) {
    let attempts = 0
    const project: Project & { codeQueries: () => number } = {
      codeQueries: () => attempts,
      async getServerHmrRoute() {
        return {
          value: {
            entryChunkPaths: ['entry/b.js'],
            chunks: [
              {
                path: 'server/chunks/b.js',
                versionId: 'v2',
                hashes: Object.entries(hashes),
              },
            ],
          },
          issues: [],
        }
      },
      async getServerHmrModules(_entryPaths, request) {
        const attempt = attempts++
        onModules?.(attempt)
        return {
          value: request.map(({ chunkPath, ids }) => ({
            chunkPath,
            versionId: 'v2',
            entries: ids.map((id): [string, ModuleEntry] => [
              id,
              { code: `/* ${id} */`, url: id, hash: hash(id, attempt) },
            ]),
          })),
          issues: [],
        }
      },
    }
    return project
  }

  async function pull(project: Project) {
    const recover = jest.fn()
    const hmr = setupServerHmr(project, {
      reEvaluateAllModulesExpensive: recover,
      onApplied: () => {},
    })
    await hmr.apply(['b.js'])
    expect(recover).not.toHaveBeenCalled()
  }

  beforeEach(() => {
    state = {
      installedHash: new Map([['shared', '1']]),
      enteredEntries: new Set(['entry/a.js']),
      installCount: 1,
    }
    g.__turbopack_server_hmr_runtimes__ = new Map([['server/chunks', state]])
    applied = []
    // Installs the update's factories, like the runtime's HMR handler does.
    g.__turbopack_server_hmr_apply__ = (update) => {
      const { entries = {} } = update.instruction as {
        entries?: Record<string, { hash: string }>
      }
      const ids = Object.keys(entries).sort()
      applied.push(ids)
      for (const id of ids) {
        state.installedHash.set(id, entries[id].hash)
        state.installCount++
      }
    }
  })

  afterEach(() => {
    delete g.__turbopack_server_hmr_runtimes__
    delete g.__turbopack_server_hmr_apply__
  })

  it('does not apply an update planned before the runtime installed a factory', async () => {
    const project = fakeProject({
      hash: (id) => hashes[id],
      onModules: (attempt) => {
        if (attempt === 0) {
          // A chunk loads while the code is read.
          state.installedHash.set('other', '9')
          state.installCount++
        }
      },
    })
    await pull(project)
    // The first plan is dropped, and the update is planned again.
    expect(project.codeQueries()).toBe(2)
    expect(applied).toEqual([['dep', 'shared']])
  })

  it('does not apply code whose hash differs from the planned one', async () => {
    const project = fakeProject({
      // The first read observes a newer compilation.
      hash: (id, attempt) =>
        attempt === 0 && id === 'shared' ? '7' : hashes[id],
    })
    await pull(project)
    expect(project.codeQueries()).toBe(2)
    expect(applied).toEqual([['dep', 'shared']])
    expect(state.installedHash.get('shared')).toBe('2')
  })
})
