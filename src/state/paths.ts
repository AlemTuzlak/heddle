import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Suggestion } from './commands'

/** An `@` path at the end of the text: an `@` at the start or after a space, then no space. */
const AT_PATH = /(^|\s)@(\S*)$/

/** The most rows for one folder. */
const MAX_ROWS = 50

/**
 * The rows of the popup for an `@` path at the end of `text`: the files and
 * the folders of `folder` whose path starts with the typed path, the folders
 * first. A name that starts with `.` shows only when the typed name starts
 * with `.`.
 *
 * `insert` is the text with the path in place of the typed part. A file ends
 * with a space, so the popup closes. A folder ends with `/`, so the popup
 * shows what is in it.
 *
 * ponytail: a path with a space in it does not work, and each call reads the
 * folder again. Add quotes and a cache when they matter.
 *
 * @param text The text of the input.
 * @param folder The project folder.
 * @example
 * pathRows('look at @src/ma', '/work')
 * // [{ label: '@src/math.mjs', detail: '', insert: 'look at @src/math.mjs ' }]
 */
export function pathRows(text: string, folder: string) {
  const typed = AT_PATH.exec(text)?.[2]
  if (typed === undefined) return []
  const slash = typed.lastIndexOf('/')
  const dir = typed.slice(0, slash + 1)
  const start = typed.slice(slash + 1)
  const before = text.slice(0, text.length - typed.length)
  let entries
  try {
    entries = readdirSync(join(folder, dir), { withFileTypes: true })
  } catch {
    // A typed folder that does not exist has no rows.
    return []
  }
  const shown = entries.filter(
    (entry) => entry.name.startsWith(start) && (start.startsWith('.') || !entry.name.startsWith('.')),
  )
  shown.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en'),
  )
  return shown.slice(0, MAX_ROWS).map((entry) => {
    const isFolder = entry.isDirectory()
    const path = `${dir}${entry.name}${isFolder ? '/' : ''}`
    const row: Suggestion = {
      label: `@${path}`,
      detail: isFolder ? 'folder' : '',
      insert: `${before}${path}${isFolder ? '' : ' '}`,
    }
    return row
  })
}
