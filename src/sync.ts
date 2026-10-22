// The sync from a sandbox container to the user's folder. The container is
// less trusted than this computer, so no change may write outside the folder.

import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Stats } from 'node:fs'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'

/** The two ends of the sync. */
export interface SyncPaths {
  /** The workspace folder in the container, a POSIX path like `/workspace`. */
  containerRoot: string
  /** The user's folder on this computer, a native path. */
  localRoot: string
}

/**
 * What {@link createSync} did with one change:
 *
 * - `'written'`: it wrote the file.
 * - `'deleted'`: it removed the file, or the file was not there.
 * - `'moved'`: it wrote the new path, and removed the old one.
 * - `'conflict'`: the file also changed in the folder. The change still ran,
 *   so the last write wins.
 * - `'refused'`: the change could write outside the folder, or into `.git`.
 *   Nothing changed.
 */
export type SyncResult = 'written' | 'deleted' | 'moved' | 'conflict' | 'refused'

/**
 * It gives the path in the user's folder of a container path, or
 * `undefined` when a write there could go outside the folder. It is
 * `undefined` for:
 *
 * - a path that is not a container path, like `C:\a` or `src/a.ts`;
 * - a path with a `..` part;
 * - a path in a `.git` folder, in any case and also in a nested repo;
 * - a path outside `containerRoot`, and `containerRoot` itself;
 * - a name that is not one plain file name here, like `a\b` on Windows;
 * - a path that is a link;
 * - a path whose deepest folder that is there is outside the real
 *   `localRoot`, after all links.
 *
 * It reads the file system, but it does not change it.
 *
 * @example
 * ```ts
 * const paths = { containerRoot: '/workspace', localRoot: 'C:\\code\\app' }
 * localPathOf('/workspace/src/a.ts', paths) // 'C:\\code\\app\\src\\a.ts'
 * localPathOf('/workspace/../etc/passwd', paths) // undefined
 * ```
 */
export function localPathOf(containerPath: string, paths: SyncPaths) {
  const names = namesIn(paths.containerRoot, containerPath)
  if (names === undefined) return undefined
  const local = join(paths.localRoot, ...names)
  return staysIn(paths.localRoot, local) ? local : undefined
}

/**
 * It copies the file changes of a sandbox to the user's folder. Each change
 * goes to the same path in the folder:
 *
 * - `'created'` and `'updated'` read the file with `read`, and write its
 *   bytes. The parent folders are made when they are not there.
 * - `'deleted'` removes the file. A file that is not there is fine.
 * - `'moved'` writes the new path, and removes the old one.
 *
 * `apply` refuses a change that could write outside the folder (see
 * {@link localPathOf}). A move is refused when one of its two paths is. A
 * change of a file that also changed in the folder, after `since` or after
 * the last write of this sync, still runs (the last write wins) and gives
 * `'conflict'`.
 *
 * The changes run one at a time, in the order of the `apply` calls. `apply`
 * throws when `read` or the file system fails, like for a full disk.
 *
 * `paths` are the two roots. `read` gives the bytes of a container file.
 * `since` is the time of the copy into the container, in milliseconds since
 * 1970.
 *
 * @example
 * ```ts
 * const sync = createSync(
 *   { containerRoot: '/workspace', localRoot: root },
 *   (path) => backend.readFile(path),
 *   { since: Date.now() },
 * )
 * const result = await sync.apply(change) // 'written'
 * ```
 */
export function createSync(
  paths: SyncPaths,
  read: (containerPath: string) => Promise<Uint8Array>,
  options: { since: number },
) {
  /** The size and the mtime of each file, right after this sync wrote it. */
  const written = new Map<string, Pick<Stats, 'mtimeMs' | 'size'>>()

  /**
   * It is true when the local file changed after the last write of this
   * sync to it, or, with no write yet, after `since`. `now` is the file now.
   */
  const isChanged = (local: string, now: Stats | undefined) => {
    const last = written.get(local)
    if (last === undefined) return now !== undefined && now.mtimeMs > options.since
    return now === undefined || now.mtimeMs !== last.mtimeMs || now.size !== last.size
  }

  /** It writes the container file to `local`. It is true for a conflict. */
  const write = async (local: string, containerPath: string) => {
    const bytes = await read(containerPath)
    const before = entryOf(local)
    const isConflict = isChanged(local, before)
    await replaceFile(local, bytes, before?.mode)
    const after = entryOf(local)
    if (after !== undefined) written.set(local, after)
    return isConflict
  }

  /** It removes `local`. It is true for a conflict. */
  const remove = async (local: string) => {
    const before = entryOf(local)
    // A file that is not there is fine: both sides removed it.
    const isConflict = before !== undefined && isChanged(local, before)
    await rm(local, { force: true })
    written.delete(local)
    return isConflict
  }

  const applyNow = async (change: FileChange) => {
    const local = localPathOf(change.path, paths)
    if (local === undefined) return 'refused'
    switch (change.change) {
      case 'created':
      case 'updated':
        return (await write(local, change.path)) ? 'conflict' : 'written'
      case 'deleted':
        return (await remove(local)) ? 'conflict' : 'deleted'
      case 'moved': {
        // The move removes the old path, so the old path gets the same
        // checks. A move without `from` only writes the new path.
        const old = change.from === undefined ? local : localPathOf(change.from, paths)
        if (old === undefined) return 'refused'
        const isNewChanged = await write(local, change.path)
        // On Windows, `A.ts` and `a.ts` are one file. Then the old path is
        // the file that was just written, and it must stay.
        const isOldChanged = !isSameFile(old, local) && (await remove(old))
        return isNewChanged || isOldChanged ? 'conflict' : 'moved'
      }
    }
  }

  // The changes run one at a time, so a change of a file never runs
  // before an earlier change of it.
  let queue: Promise<unknown> = Promise.resolve()
  const sync: { apply(change: FileChange): Promise<SyncResult> } = {
    apply(change) {
      const result = queue.then(() => applyNow(change))
      queue = result.catch(() => undefined)
      return result
    },
  }
  return sync
}

/**
 * A name that is not one plain file name on Windows:
 *
 * - `\` and `:` make a path, a drive, or a stream, like `..\a` or `C:a`.
 * - `<>"|?*` and the control characters are not allowed in a name.
 * - Windows drops a `.` or a space at the end of a name.
 * - `con`, `nul`, `com1`, and the other device names open a device.
 */
const WINDOWS_UNSAFE_NAME =
  /[\x00-\x1f<>:"\\|?*]|[. ]$|^(con|prn|aux|nul|com[\d\u00b9\u00b2\u00b3]|lpt[\d\u00b9\u00b2\u00b3]) *(\.|$)/i

/** It is true when `name` is one plain file name on this computer. */
function isPlainName(name: string) {
  return process.platform === 'win32'
    ? !WINDOWS_UNSAFE_NAME.test(name)
    : !name.includes('\0')
}

/**
 * The names of `containerPath` in `containerRoot`, like `['src', 'a.ts']`.
 * It is `undefined` for a path outside the root (also a path of this
 * computer, like `C:\a`), the root itself, a path with a `..` part, and a
 * path with a name that is not plain here.
 */
function namesIn(containerRoot: string, containerPath: string) {
  const prefix = containerRoot.endsWith('/') ? containerRoot : `${containerRoot}/`
  if (!containerPath.startsWith(prefix)) return undefined
  // Empty and `.` parts change nothing, like in `/workspace//src/./a.ts`.
  const names = containerPath
    .slice(prefix.length)
    .split('/')
    .filter((name) => name !== '' && name !== '.')
  const isRoot = names.length === 0
  if (isRoot || names.includes('..') || names.some(isGitFolder)) return undefined
  return names.every(isPlainName) ? names : undefined
}

/**
 * True for `.git`, in any case. Git on this computer runs the hooks and reads
 * the config in a `.git` folder, so a sandbox never writes there. Its commits
 * stay in the container, and its file changes come back as changes.
 */
function isGitFolder(name: string) {
  return name.toLowerCase() === '.git'
}

/** The `lstat` of `path`, or `undefined` when nothing is there. It never follows a link. */
const entryOf = (path: string) => lstatSync(path, { throwIfNoEntry: false })

/**
 * It is true when a write to `local` stays in the real `localRoot`:
 *
 * - `local` itself is not a link;
 * - the deepest folder of `local` that is there is in the real root, after
 *   all links. A link that points to nothing is there too. It has no real
 *   path, so it is refused.
 */
function staysIn(localRoot: string, local: string) {
  if (entryOf(local)?.isSymbolicLink()) return false
  let folder = dirname(local)
  while (entryOf(folder) === undefined) {
    const parent = dirname(folder)
    // Not even the top folder is there.
    if (parent === folder) return false
    folder = parent
  }
  try {
    // `native` gives the long names on Windows, not short names like `ALEMTU~1`.
    const rel = relative(realpathSync.native(localRoot), realpathSync.native(folder))
    const isOutside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    // The real path catches a short name of `.git`, like `GIT~1` on Windows.
    return !isOutside && !rel.split(sep).some(isGitFolder)
  } catch {
    // A link that points to nothing, or a root that is gone.
    return false
  }
}

/** It is true when `a` and `b` name one file, like `A.ts` and `a.ts` on Windows. */
function isSameFile(a: string, b: string) {
  // `bigint`, because a file id on Windows can be bigger than a safe number.
  const first = lstatSync(a, { bigint: true, throwIfNoEntry: false })
  const second = lstatSync(b, { bigint: true, throwIfNoEntry: false })
  if (first === undefined || second === undefined) return false
  return first.dev === second.dev && first.ino === second.ino
}

/**
 * It writes `bytes` to a new file next to `local`, then renames the new file
 * onto `local`. The rename replaces the name `local` itself, so the write
 * never goes through a link, or into a hard link of the file in another
 * folder (like a file of the pnpm store). A reader never sees half a file.
 * `mode` is the mode of the old file, so a script that runs still runs.
 */
async function replaceFile(local: string, bytes: Uint8Array, mode: number | undefined) {
  const folder = dirname(local)
  await mkdir(folder, { recursive: true })
  const temp = join(folder, `.heddle-${randomUUID()}.tmp`)
  try {
    // `wx` makes a new file, and fails when the name is there.
    await writeFile(temp, bytes, { flag: 'wx' })
    if (mode !== undefined) await chmod(temp, mode & 0o777)
    await rename(temp, local)
  } catch (error) {
    // The first error tells what went wrong, so an error here is dropped.
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
