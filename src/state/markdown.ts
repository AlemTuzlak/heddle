// Markdown as timeline segments: enough for the answers of a model. The
// timeline wraps the segments, so this only styles the text.
import { color } from '../ui/theme'
import type { Segment } from './timeline'

type Style = Omit<Segment, 'text'>

/**
 * `` `code` ``, `**bold**`, `*italic*`, and `[text](url)`. An `_` does not
 * mark italic text, because names such as `max_tokens` have it.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g

const FENCE = /^\s*(```|~~~)/
const HEADING = /^#{1,6}\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

/** The inline marks of one line, in the style `base`. */
function inline(text: string, base: Style) {
  const segments: Array<Segment> = []
  let end = 0
  for (const match of text.matchAll(INLINE)) {
    if (match.index > end) segments.push({ ...base, text: text.slice(end, match.index) })
    const [, code, bold, italic, label, url] = match
    if (code !== undefined) segments.push({ ...base, text: code, fg: color.keyword })
    else if (bold !== undefined) segments.push({ ...base, text: bold, bold: true })
    else if (italic !== undefined) segments.push({ ...base, text: italic, italic: true })
    else segments.push({ ...base, text: label ?? '' }, { text: ` (${url})`, fg: color.muted })
    end = match.index + match[0].length
  }
  if (end < text.length) segments.push({ ...base, text: text.slice(end) })
  return segments
}

/** One line of markdown outside a code block. */
function lineSegments(line: string, fg: string) {
  const base: Style = { fg }
  const heading = HEADING.exec(line)
  if (heading) return inline(heading[1] ?? '', { fg, bold: true })
  if (RULE.test(line)) return [{ text: '───', fg: color.faint }]
  const bullet = BULLET.exec(line)
  if (bullet) return [{ text: `${bullet[1]}• `, fg: color.muted }, ...inline(bullet[2] ?? '', base)]
  const numbered = NUMBERED.exec(line)
  if (numbered) {
    return [{ text: `${numbered[1]}${numbered[2]} `, fg: color.muted }, ...inline(numbered[3] ?? '', base)]
  }
  const quote = QUOTE.exec(line)
  if (quote) return [{ text: '│ ', fg: color.faint }, ...inline(quote[1] ?? '', { fg: color.muted, italic: true })]
  return inline(line, base)
}

/**
 * The segments of a markdown text, with `\n` between the lines.
 *
 * - `#` headings are bold. `**bold**`, `*italic*`, and `` `code` `` have their
 *   style, and the marks do not show.
 * - A list item starts with `•` or its number. A `>` quote is muted italic.
 * - A fenced code block shows its lines in the code color, 2 cells in. The
 *   fence lines do not show. A block that is not closed yet, as while the
 *   answer streams, runs to the end.
 * - A link shows its text, then its URL in muted.
 *
 * ponytail: no tables and no syntax colors. A table shows as its text. Add
 * them when answers need them.
 *
 * @param text The markdown text.
 * @param fg The color of plain text.
 * @example
 * markdownSegments('Run `bun test`.', color.linen)
 * // [{ text: 'Run ', fg }, { text: 'bun test', fg: color.keyword }, { text: '.', fg }]
 */
export function markdownSegments(text: string, fg: string) {
  const lines: Array<Array<Segment>> = []
  let inCode = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inCode = !inCode
      continue
    }
    lines.push(inCode ? [{ text: `  ${line}`, fg: color.keyword }] : lineSegments(line, fg))
  }
  return lines.flatMap((segments, index) => (index === 0 ? segments : [{ text: '\n' }, ...segments]))
}
