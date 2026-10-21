import { SyntaxStyle, type CliRenderer } from '@opentui/core'

/** The heddle palette. Each value is a hex color for the OpenTUI `fg` and `bg` props. */
export const color = {
  loom: '#171614',
  surface: '#1e1c19',
  line: '#34312c',
  linen: '#e8e2d6',
  muted: '#8f887b',
  faint: '#5f594f',
  indigo: '#8f96ff',
  indigoDim: '#555a9e',
  lavender: '#c4a7ff',
  woad: '#7cc4a0',
  woadBg: '#1d2922',
  madder: '#e0786f',
  madderBg: '#2d1d1b',
  weld: '#e3c26a',
  weldBg: '#24200f',
  keyword: '#a9b0ff',
  /** The quiet background of a selected row, as in the mockup. */
  selectedBg: '#23222f',
} as const

/** The glyphs of the timeline and the changes pane. `spinner` has one frame for each character. */
export const glyph = {
  read: '◇',
  write: '◆',
  dot: '●',
  spine: '│',
  open: '├─╮',
  close: '├─╯',
  more: '┊',
  spinner: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
} as const

/**
 * Makes the syntax colors for `<code>` and `<diff>`:
 *
 * - `keyword`: `color.keyword`
 * - `string`: `color.woad`
 * - `comment`: `color.faint`
 * - `number`: `color.weld`
 * - `default` (all other text): `color.linen`
 *
 * The style belongs to the renderer that you give. Make one style for each
 * renderer, and do not give it to a different renderer.
 *
 * @param renderer The renderer that draws the code.
 * @example
 * const renderer = useRenderer()
 * const syntaxStyle = useMemo(() => createSyntaxStyle(renderer), [renderer])
 * return <code content={source} filetype="typescript" syntaxStyle={syntaxStyle} />
 */
export function createSyntaxStyle(renderer: CliRenderer) {
  return SyntaxStyle.fromStyles(
    {
      keyword: { fg: color.keyword },
      string: { fg: color.woad },
      comment: { fg: color.faint },
      number: { fg: color.weld },
      default: { fg: color.linen },
    },
    renderer.nativeScene,
  )
}
