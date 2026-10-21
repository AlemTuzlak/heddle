import { color } from './theme'

/** One key hint: the key, then what it does. */
export interface Hint {
  key: string
  label: string
}

/**
 * The row of key hints at the bottom of heddle, for example
 * `enter send   esc stop   tab next pane`. A key is linen and its label is
 * muted. The row is one line high: a hint that does not fit is left out
 * whole, from the end.
 *
 * @param hints The hints, in the order to show them.
 * @example
 * <Hints hints={[{ key: 'enter', label: 'send' }, { key: 'esc', label: 'stop' }]} />
 */
export function Hints({ hints }: { hints: ReadonlyArray<Hint> }) {
  // A hint that does not fit wraps to the second line, which the row hides.
  return (
    <box
      flexDirection="row"
      flexWrap="wrap"
      columnGap={3}
      height={1}
      overflow="hidden"
      flexShrink={0}
    >
      {hints.map((hint) => (
        <text key={hint.key} fg={color.muted} wrapMode="none" flexShrink={0}>
          <span fg={color.linen}>{hint.key}</span>
          {` ${hint.label}`}
        </text>
      ))}
    </box>
  )
}
