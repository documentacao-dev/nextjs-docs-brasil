const fs = require('fs')
const os = require('os')
const path = require('path')

// The dev Node.js runtime, which records the code of every factory it installs.
const repoRoot = path.resolve(process.cwd(), '../../../../../../../..')
const runtimeDir = path.join(
  repoRoot,
  'turbopack/crates/turbopack-tests/tests/snapshot/debug-ids/node/output'
)

function writeChunk(filePath, chunkModules, hashes) {
  fs.writeFileSync(
    filePath,
    `module.exports = ${chunkModules};\n` +
      (hashes
        ? `globalThis.__turbopack_register_module_hashes__?.(module.exports, ${JSON.stringify(Object.entries(hashes))});\n`
        : '')
  )
}

function factory(value) {
  return `function (__turbopack_context__, module) { module.exports = ${JSON.stringify(value)} }`
}

it('records the code of the factories the runtime installs', () => {
  const runtimePath = path.join(runtimeDir, '[turbopack]_runtime.js')
  const runtimeRequire = eval('require')
  delete runtimeRequire.cache[runtimeRequire.resolve(runtimePath)]
  const statesBefore = new Set(
    globalThis.__turbopack_server_hmr_runtimes__?.values() ?? []
  )
  const createRuntime = runtimeRequire(runtimePath)
  // The runtime registers its state by output directory as it loads.
  const state = Array.from(
    globalThis.__turbopack_server_hmr_runtimes__?.values() ?? []
  ).find((state) => !statesBefore.has(state))
  expect(state).toBeDefined()

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const id = (name) => `${name}-${suffix}`
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-installed-hashes-'))
  try {
    const runtime = createRuntime('entry/a.js')
    expect(state.enteredEntries.has('entry/a.js')).toBe(true)
    const installCount = state.installCount

    const first = path.join(tempDir, 'first.js')
    // The first factory of `x` reports what is recorded when it is disposed.
    writeChunk(
      first,
      `[${JSON.stringify(id('x'))}, function (__turbopack_context__, module) { module.hot.dispose(() => globalThis.__installedHashesDisposeProbe()); module.exports = 'x1' }]`,
      { [id('x')]: '1' }
    )
    runtime.c(first)
    expect(state.installedHash.get(id('x'))).toBe('1')
    expect(state.installCount).toBeGreaterThan(installCount)

    // A later chunk doesn't replace the factory, so its hash isn't recorded.
    const second = path.join(tempDir, 'second.js')
    writeChunk(
      second,
      `[${JSON.stringify(id('x'))}, ${factory('x2')}, ${JSON.stringify(id('y'))}, ${factory('y')}]`,
      { [id('x')]: '2', [id('y')]: '3' }
    )
    runtime.c(second)
    expect(runtime.m(id('x')).exports).toBe('x1')
    expect(state.installedHash.get(id('x'))).toBe('1')
    expect(state.installedHash.get(id('y'))).toBe('3')

    // `z` gets the existing factory of its group, which was installed for `x`
    // by a chunk that didn't list `z`. So its code isn't known, even though the
    // chunk that installs it lists `z` with a hash.
    const group = path.join(tempDir, 'group.js')
    writeChunk(
      group,
      `[${JSON.stringify(id('x'))}, ${JSON.stringify(id('z'))}, ${factory('group')}]`,
      { [id('x')]: '4', [id('z')]: '4' }
    )
    runtime.c(group)
    expect(runtime.m(id('z')).exports).toBe('x1')
    expect(state.installedHash.has(id('z'))).toBe(true)
    expect(state.installedHash.get(id('z'))).toBeNull()

    // A factory without a hash is installed, at unknown code.
    const unhashed = path.join(tempDir, 'unhashed.js')
    writeChunk(unhashed, `[${JSON.stringify(id('w'))}, ${factory('w')}]`)
    runtime.c(unhashed)
    expect(state.installedHash.has(id('w'))).toBe(true)
    expect(state.installedHash.get(id('w'))).toBeNull()

    // A server HMR update records the code of a factory it installs when it
    // installs it: after dispose handlers of the replaced module ran, and
    // before any module runs the new factory.
    const hmr = globalThis.__turbopack_server_hmr_handlers__?.get(runtimePath)
    expect(hmr).toBeDefined()
    let hashSeenByDispose
    globalThis.__installedHashesDisposeProbe = () => {
      hashSeenByDispose = state.installedHash.get(id('x'))
    }
    let hashSeenByNewFactory
    globalThis.__installedHashesProbe = () => {
      hashSeenByNewFactory = state.installedHash.get(id('x'))
      return 'x3'
    }
    const installCountBeforeUpdate = state.installCount
    hmr.handler({
      type: 'partial',
      instruction: {
        type: 'EcmascriptMergedUpdate',
        entries: {
          [id('x')]: {
            code: 'function (__turbopack_context__, module) { module.exports = globalThis.__installedHashesProbe() }',
            url: 'x-update.js',
            hash: '5',
          },
        },
        chunks: { [`${hmr.chunkPrefix}/first.js`]: { type: 'partial' } },
      },
    })
    expect(runtime.m(id('x')).exports).toBe('x3')
    expect(hashSeenByDispose).toBe('1')
    expect(hashSeenByNewFactory).toBe('5')
    expect(state.installedHash.get(id('x'))).toBe('5')
    expect(state.installCount).toBeGreaterThan(installCountBeforeUpdate)
  } finally {
    delete globalThis.__installedHashesProbe
    delete globalThis.__installedHashesDisposeProbe
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
