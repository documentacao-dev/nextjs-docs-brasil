const fs = require('fs')
const path = require('path')

const relativeDir =
  'turbopack/crates/turbopack-tests/tests/execution/turbopack/code-gen/dirname-filename/input'

it('__dirname and __filename should be the real paths of the module', () => {
  expect(path.isAbsolute(__dirname)).toBe(true)
  expect(__dirname).not.toMatch(/^\/ROOT\//)
  expect(__dirname.split(path.sep).join('/')).toMatch(
    new RegExp(`/${relativeDir}$`)
  )
  expect(__filename).toBe(path.join(__dirname, 'index.js'))
  expect({ __dirname, __filename }).toEqual({
    __dirname: path.dirname(__filename),
    __filename,
  })
})

it('should read files relative to __dirname', () => {
  expect(fs.readFileSync(path.join(__dirname, 'data.txt'), 'utf8').trim()).toBe(
    'data'
  )
  expect(require('./nested/reader.js').read()).toBe('nested-data')
})

it('should look up runtime context keys with mixed separators', () => {
  // On Windows, context keys computed from `__dirname` use `\` as separator,
  // while requests built from it can mix in `/`.
  const context = __turbopack_context__.f([
    'C:\\project\\dir\\a.js',
    () => 'a',
    '/project/dir/b.js',
    () => 'b',
  ])
  expect(context('C:\\project\\dir\\a.js')).toBe('a')
  expect(context('C:\\project\\dir/a.js')).toBe('a')
  expect(context('C:/project/dir/a.js')).toBe('a')
  expect(context('/project/dir/b.js')).toBe('b')
  // Only keys containing `\` are looked up with `/` as separator.
  expect(() => context('\\project\\dir\\b.js')).toThrow(/Cannot find module/)
})
