import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { createSync, localPathOf } from './sync'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'

/** The time of the copy into the container. */
const SINCE = Date.parse('2020-01-01T00:00:00Z')
/** A time before the copy: the file did not change after it. */
const BEFORE = new Date(SINCE - 60_000)
/** A time after the copy: the user changed the file. */
const AFTER = new Date(SINCE + 60_000)

const isWindows = process.platform === 'win32'
/** Windows and macOS see `a.ts` and `A.TS` as one file. */
const isCaseBlind =
  existsSync(tmpdir().toUpperCase()) && existsSync(tmpdir().toLowerCase())

/** The tree of the temp folder when nothing was written. */
const UNTOUCHED = ['outside', 'root']

const encode = (text: string) => new TextEncoder().encode(text)

/** A change in the container, as the tools send it. */
function fileChange(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, change: 'updated', additions: 0, deletions: 0, ...overrides }
}

/** The paths in `folder`, with `/`, sorted. It does not go into links. */
async function treeOf(folder: string) {
  const paths = await readdir(folder, { recursive: true })
  return paths.map((path) => path.replaceAll('\\', '/')).sort()
}

/**
 * A temp folder with the user's folder `root` and a folder `outside` next
 * to it, and a sync from a fake container to `root`. `await using` removes
 * the temp folder.
 */
async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'heddle-sync-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const paths = { containerRoot: '/workspace', localRoot: root }
  /** The files of the fake container, by container path. */
  const files = new Map<string, Uint8Array>()
  const read = async (path: string) => {
    const bytes = files.get(path)
    if (bytes === undefined) throw new Error(`The container has no file ${path}.`)
    return bytes
  }
  return {
    base,
    root,
    outside,
    paths,
    sync: createSync(paths, read, { since: SINCE }),
    /** It puts a file in the container. */
    inContainer: (path: string, content: string | Uint8Array) => {
      files.set(path, typeof content === 'string' ? encode(content) : content)
    },
    /** It writes a file in `root`, with its time at `time`. */
    inFolder: async (name: string, text: string, time = BEFORE) => {
      await writeFile(join(root, name), text)
      await utimes(join(root, name), time, time)
    },
    /** The text of a file in `root`. */
    textOf: (path: string) => readFile(join(root, path), 'utf8'),
    [Symbol.asyncDispose]: () => rm(base, { recursive: true, force: true }),
  }
}

test('localPathOf gives the same path in the folder', async () => {
  await using dirs = await setup()
  expect(localPathOf('/workspace/src/a.ts', dirs.paths)).toBe(
    `${dirs.root}${sep}src${sep}a.ts`,
  )
  expect(localPathOf('/etc/passwd', dirs.paths)).toBeUndefined()
})

test('created writes the bytes', async () => {
  await using dirs = await setup()
  dirs.inContainer('/workspace/src/ui/new.ts', 'export const a = 1\n')
  const created = fileChange('/workspace/src/ui/new.ts', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('written')
  // The parent folders are new too.
  expect(await dirs.textOf('src/ui/new.ts')).toBe('export const a = 1\n')
})

test('deleted removes the file', async () => {
  await using dirs = await setup()
  await dirs.inFolder('old.ts', 'old')
  const deleted = fileChange('/workspace/old.ts', { change: 'deleted' })
  expect(await dirs.sync.apply(deleted)).toBe('deleted')
  expect(await treeOf(dirs.root)).toEqual([])
})

test('a delete of a missing file is fine', async () => {
  await using dirs = await setup()
  dirs.inContainer('/workspace/a.ts', 'agent')
  const created = fileChange('/workspace/a.ts', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('written')
  // The user removed the file that heddle wrote. Both sides agree.
  await rm(join(dirs.root, 'a.ts'))
  const deleted = fileChange('/workspace/a.ts', { change: 'deleted' })
  expect(await dirs.sync.apply(deleted)).toBe('deleted')
})

test('moved renames', async () => {
  await using dirs = await setup()
  await dirs.inFolder('old.ts', 'before')
  dirs.inContainer('/workspace/lib/new.ts', 'after')
  const moved = fileChange('/workspace/lib/new.ts', {
    change: 'moved',
    from: '/workspace/old.ts',
  })
  expect(await dirs.sync.apply(moved)).toBe('moved')
  expect(await treeOf(dirs.root)).toEqual(['lib', 'lib/new.ts'])
  expect(await dirs.textOf('lib/new.ts')).toBe('after')
})

test('refuses /workspace/../etc/passwd', async () => {
  await using dirs = await setup()
  dirs.inContainer('/workspace/../etc/passwd', 'root:x:0:0')
  const created = fileChange('/workspace/../etc/passwd', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('refused')
  expect(await treeOf(dirs.base)).toEqual(UNTOUCHED)
})

test('refuses a .. part that stays in the root', async () => {
  await using dirs = await setup()
  // In the container, `src` can be a link, so the path can be another file.
  dirs.inContainer('/workspace/src/../a.ts', 'text')
  const created = fileChange('/workspace/src/../a.ts', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('refused')
  expect(await treeOf(dirs.base)).toEqual(UNTOUCHED)
})

test('refuses a path outside the root', async () => {
  await using dirs = await setup()
  // The second path starts with the text of the root, but it is not in it.
  // The third path from the root is `../root/.bashrc`, and the local root
  // is named `root`, so a plain join puts it in the folder.
  const paths = ['/etc/passwd', '/workspace2/a.ts', '/root/.bashrc']
  for (const path of paths) {
    dirs.inContainer(path, 'text')
    expect(await dirs.sync.apply(fileChange(path, { change: 'created' }))).toBe('refused')
  }
  expect(await treeOf(dirs.base)).toEqual(UNTOUCHED)
})

test('refuses a path that is not a container path', async () => {
  await using dirs = await setup()
  // A path of this computer, in the folder next to the root.
  const path = join(dirs.outside, 'evil.ts')
  dirs.inContainer(path, 'text')
  expect(await dirs.sync.apply(fileChange(path, { change: 'created' }))).toBe('refused')
  expect(await treeOf(dirs.base)).toEqual(UNTOUCHED)
})

test('refuses the root folder itself', async () => {
  await using dirs = await setup()
  const paths = ['/workspace', '/workspace/', '/workspace/.']
  for (const path of paths) {
    expect(await dirs.sync.apply(fileChange(path, { change: 'deleted' }))).toBe('refused')
  }
  expect(await treeOf(dirs.base)).toEqual(UNTOUCHED)
  // Also when the folder is the top folder of a drive, like `C:\`.
  const top = { containerRoot: '/workspace', localRoot: parse(dirs.root).root }
  expect(localPathOf('/workspace/', top)).toBeUndefined()
})

test('refuses a link that points outside', async () => {
  await using dirs = await setup()
  // A junction needs no admin rights on Windows. Other systems ignore the type.
  await symlink(dirs.outside, join(dirs.root, 'link'), 'junction')
  dirs.inContainer('/workspace/link/evil.ts', 'text')
  const created = fileChange('/workspace/link/evil.ts', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('refused')
  expect(await treeOf(dirs.base)).toEqual(['outside', 'root', 'root/link'])
})

test('refuses a link as the target', async () => {
  await using dirs = await setup()
  await symlink(dirs.outside, join(dirs.root, 'link'), 'junction')
  dirs.inContainer('/workspace/link', 'text')
  expect(await dirs.sync.apply(fileChange('/workspace/link'))).toBe('refused')
  expect(await treeOf(dirs.base)).toEqual(['outside', 'root', 'root/link'])
  expect((await lstat(join(dirs.root, 'link'))).isSymbolicLink()).toBe(true)
})

test('a move from outside the root deletes nothing', async () => {
  await using dirs = await setup()
  await writeFile(join(dirs.outside, 'keep.ts'), 'keep')
  dirs.inContainer('/workspace/keep.ts', 'keep')
  const moved = fileChange('/workspace/keep.ts', {
    change: 'moved',
    from: '/workspace/../outside/keep.ts',
  })
  expect(await dirs.sync.apply(moved)).toBe('refused')
  expect(await treeOf(dirs.base)).toEqual(['outside', 'outside/keep.ts', 'root'])
})

test.if(isWindows)('refuses a name that Windows reads as a path', async () => {
  await using dirs = await setup()
  // Each is one name in the container. On Windows, the first goes up out of
  // the root, and the second is a stream of the file `C`.
  const paths = ['/workspace/..\\outside\\evil.ts', '/workspace/C:evil.ts']
  for (const path of paths) {
    dirs.inContainer(path, 'text')
    expect(await dirs.sync.apply(fileChange(path, { change: 'created' }))).toBe('refused')
  }
  expect(await treeOf(dirs.base)).toEqual(UNTOUCHED)
})

test('conflict when the local file changed after since', async () => {
  await using dirs = await setup()
  await dirs.inFolder('a.ts', 'mine', AFTER)
  dirs.inContainer('/workspace/a.ts', 'agent')
  expect(await dirs.sync.apply(fileChange('/workspace/a.ts'))).toBe('conflict')
  // The last write wins.
  expect(await dirs.textOf('a.ts')).toBe('agent')
})

test("no conflict for heddle's own last write", async () => {
  await using dirs = await setup()
  await dirs.inFolder('a.ts', 'start')
  dirs.inContainer('/workspace/a.ts', 'agent 1')
  expect(await dirs.sync.apply(fileChange('/workspace/a.ts'))).toBe('written')
  // That write made the file newer than `since`, but heddle made it.
  dirs.inContainer('/workspace/a.ts', 'agent 2')
  expect(await dirs.sync.apply(fileChange('/workspace/a.ts'))).toBe('written')
  expect(await dirs.textOf('a.ts')).toBe('agent 2')
})

test("conflict when the local file changed after heddle's write", async () => {
  await using dirs = await setup()
  dirs.inContainer('/workspace/a.ts', 'agent 1')
  const created = fileChange('/workspace/a.ts', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('written')
  await writeFile(join(dirs.root, 'a.ts'), 'my own edit')
  dirs.inContainer('/workspace/a.ts', 'agent 2')
  expect(await dirs.sync.apply(fileChange('/workspace/a.ts'))).toBe('conflict')
  expect(await dirs.textOf('a.ts')).toBe('agent 2')
})

test('binary bytes stay the same', async () => {
  await using dirs = await setup()
  // Each byte value once. Most of them are not valid UTF-8 alone.
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  dirs.inContainer('/workspace/image.bin', bytes)
  const created = fileChange('/workspace/image.bin', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('written')
  expect(new Uint8Array(await readFile(join(dirs.root, 'image.bin')))).toEqual(bytes)
})

test('a delete of a changed file is a conflict', async () => {
  await using dirs = await setup()
  await dirs.inFolder('a.ts', 'mine', AFTER)
  const deleted = fileChange('/workspace/a.ts', { change: 'deleted' })
  expect(await dirs.sync.apply(deleted)).toBe('conflict')
  // The delete still happens.
  expect(await treeOf(dirs.root)).toEqual([])
})

test.if(isCaseBlind)('a move that only changes the case keeps the file', async () => {
  await using dirs = await setup()
  await dirs.inFolder('readme.md', 'old')
  dirs.inContainer('/workspace/README.md', 'new')
  const moved = fileChange('/workspace/README.md', {
    change: 'moved',
    from: '/workspace/readme.md',
  })
  expect(await dirs.sync.apply(moved)).toBe('moved')
  expect(await treeOf(dirs.root)).toEqual(['README.md'])
  expect(await dirs.textOf('README.md')).toBe('new')
})

test.skipIf(isWindows)('a rewrite keeps the mode of the file', async () => {
  await using dirs = await setup()
  await dirs.inFolder('run.sh', 'echo old')
  await chmod(join(dirs.root, 'run.sh'), 0o755)
  dirs.inContainer('/workspace/run.sh', 'echo new')
  expect(await dirs.sync.apply(fileChange('/workspace/run.sh'))).toBe('written')
  expect((await stat(join(dirs.root, 'run.sh'))).mode & 0o777).toBe(0o755)
})

test('a failed write throws, and the next change still runs', async () => {
  await using dirs = await setup()
  // The folder has a folder where the container has a file, so the rename fails.
  await mkdir(join(dirs.root, 'src'))
  dirs.inContainer('/workspace/src', 'text')
  await expect(dirs.sync.apply(fileChange('/workspace/src'))).rejects.toThrow()
  // No temp file stays.
  expect(await treeOf(dirs.root)).toEqual(['src'])
  dirs.inContainer('/workspace/a.ts', 'agent')
  const created = fileChange('/workspace/a.ts', { change: 'created' })
  expect(await dirs.sync.apply(created)).toBe('written')
})

test('changes run one at a time, in order', async () => {
  await using dirs = await setup()
  let release = () => {}
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const read = async () => {
    await slow
    return encode('agent')
  }
  const sync = createSync(dirs.paths, read, { since: SINCE })
  const written = sync.apply(fileChange('/workspace/a.ts', { change: 'created' }))
  const deleted = sync.apply(fileChange('/workspace/a.ts', { change: 'deleted' }))
  // The delete came last, so it waits for the slow write.
  await Bun.sleep(50)
  release()
  expect([await written, await deleted]).toEqual(['written', 'deleted'])
  expect(await treeOf(dirs.root)).toEqual([])
})
