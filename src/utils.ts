// Small helpers that the state and UI modules share. They know nothing about heddle.

/** True for a JSON object: not `null`, and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The mark at the end or at the start of a text that is cut. */
const ELLIPSIS = '…'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The characters of `text` as the user sees them: an emoji with its modifiers is one. */
export function graphemes(text: string) {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
}

/** The first characters that fill at most `width` terminal cells. */
function takeWidth(characters: ReadonlyArray<string>, width: number) {
  const taken: Array<string> = []
  let used = 0
  for (const character of characters) {
    const cells = Bun.stringWidth(character)
    if (used + cells > width) break
    taken.push(character)
    used += cells
  }
  return taken
}

/**
 * `text` in at most `width` terminal cells. A longer text keeps its start and
 * ends with `…`.
 *
 * @example
 * cutEnd('Fix the failing add test', 10) // 'Fix the f…'
 */
export function cutEnd(text: string, width: number) {
  if (width < 1) return ''
  if (Bun.stringWidth(text) <= width) return text
  return takeWidth(graphemes(text), width - 1).join('') + ELLIPSIS
}

/**
 * `text` in at most `width` terminal cells. A longer text keeps its end and
 * starts with `…`, so the end of a path or of a typed line stays in view.
 *
 * @example
 * cutStart('Fix the failing add test', 10) // '…add test'
 */
export function cutStart(text: string, width: number) {
  if (width < 1) return ''
  if (Bun.stringWidth(text) <= width) return text
  const characters = graphemes(text).reverse()
  return ELLIPSIS + takeWidth(characters, width - 1).reverse().join('')
}

/** `text` with spaces after it, so that it fills `width` terminal cells. */
export function padWidth(text: string, width: number) {
  return text + ' '.repeat(Math.max(0, width - Bun.stringWidth(text)))
}

/** The width of the widest of `texts`, in terminal cells. 0 when there are none. */
export function widest(texts: ReadonlyArray<string>) {
  return Math.max(0, ...texts.map((text) => Bun.stringWidth(text)))
}

/** `path` relative to `root`, with `/`. A path outside `root` stays as it is. */
export function relativePath(path: string, root: string) {
  const slashed = path.replaceAll('\\', '/')
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '')
  // On Windows, two paths that differ only in case are the same path.
  const isWindows = /^[a-z]:/i.test(base)
  const comparable = (text: string) => (isWindows ? text.toLowerCase() : text)
  if (comparable(slashed) === comparable(base)) return '.'
  const isInside = comparable(slashed).startsWith(`${comparable(base)}/`)
  return isInside
    ? slashed.slice(base.length + 1)
    : slashed.replace(/^\.\//, '')
}
