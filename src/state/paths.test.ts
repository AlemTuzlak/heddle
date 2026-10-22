import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempFolder } from '../test-utils'
import { pathRows } from './paths'

/** A project with `src/math.mjs`, `src/cli.mjs`, `README.md`, and `.git/`. */
function project() {
  const folder = tempFolder()
  mkdirSync(join(folder.path, 'src'))
  mkdirSync(join(folder.path, '.git'))
  writeFileSync(join(folder.path, 'src', 'math.mjs'), '')
  writeFileSync(join(folder.path, 'src', 'cli.mjs'), '')
  writeFileSync(join(folder.path, 'README.md'), '')
  return folder
}

test('an @ lists the folders first, then the files, with no hidden names', () => {
  using folder = project()
  expect(pathRows('look at @', folder.path)).toEqual([
    { label: '@src/', detail: 'folder', insert: 'look at @src/' },
    { label: '@README.md', detail: '', insert: 'look at @README.md ' },
  ])
  expect(pathRows('@.g', folder.path).map((row) => row.label)).toEqual(['@.git/'])
})

test('a typed folder lists what is in it that starts with the typed name', () => {
  using folder = project()
  expect(pathRows('@src/m', folder.path)).toEqual([
    { label: '@src/math.mjs', detail: '', insert: '@src/math.mjs ' },
  ])
})

test('no rows for an @ in a word, for a folder that does not exist, or after a space', () => {
  using folder = project()
  expect(pathRows('me@acme.dev', folder.path)).toEqual([])
  expect(pathRows('@nope/', folder.path)).toEqual([])
  expect(pathRows('@src/math.mjs ', folder.path)).toEqual([])
})
