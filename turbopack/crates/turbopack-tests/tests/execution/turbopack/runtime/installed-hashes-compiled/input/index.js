import { value } from './sync.js'

function ownState() {
  // The runtime registers its state by output directory.
  const states = Array.from(
    globalThis.__turbopack_server_hmr_runtimes__?.values() ?? []
  )
  return states.find((state) =>
    Array.from(state.installedHash.keys()).some((id) =>
      String(id).includes('installed-hashes-compiled/input/index.js')
    )
  )
}

function hashOf(state, file) {
  const entry = Array.from(state.installedHash).find(([id]) =>
    String(id).endsWith(
      `installed-hashes-compiled/input/${file} [test] (ecmascript)`
    )
  )
  return entry?.[1]
}

it('records the hashes of the modules of loaded chunks', async () => {
  expect(value).toBe('sync')
  const state = ownState()
  expect(state).toBeDefined()
  expect(state.enteredEntries.size).toBeGreaterThan(0)
  expect(typeof hashOf(state, 'index.js')).toBe('string')
  expect(hashOf(state, 'lazy.js')).toBeUndefined()

  const installCount = state.installCount
  const lazy = await import('./lazy.js')
  expect(lazy.value).toBe('lazy')
  expect(typeof hashOf(state, 'lazy.js')).toBe('string')
  expect(state.installCount).toBeGreaterThan(installCount)
})
