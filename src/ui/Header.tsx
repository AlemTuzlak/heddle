import { color, glyph } from './theme'

/** What the header shows about the open session. */
export interface HeaderProps {
  /** The session title. */
  title?: string
  /** The goal of `/goal`, and the round it is in. */
  goal?: { text: string; round: number; max?: number }
  /** The model label, for example `opus 5.5`. */
  model: string
  /** The agent profile, for example `build`. */
  agent?: string
  /** Where the tools run. */
  place: 'local' | 'docker'
  /** The state of the copy back to the folder, in a Docker sandbox. */
  sync?: 'starting' | 'synced' | 'syncing' | 'conflict' | 'stopped'
  /** The part of the context window in use, from 0 to 1. */
  context?: number
  /** The cost of the session, in US dollars. */
  cost?: number
  /** The provider of the current model, when it has no API key. */
  missingKey?: string
}

/** Green when the folder is up to date, yellow while a copy runs, red on a conflict. */
const SYNC_COLOR: Record<NonNullable<HeaderProps['sync']>, string> = {
  starting: color.weld,
  syncing: color.weld,
  synced: color.woad,
  conflict: color.madder,
  stopped: color.faint,
}

/** The number of cells in the context meter. */
const METER_CELLS = 10

/** The goal chip text, for example `tests pass, round 2 of 20`. */
function goalText(goal: NonNullable<HeaderProps['goal']>) {
  const round =
    goal.max === undefined ? `round ${goal.round}` : `round ${goal.round} of ${goal.max}`
  return `${goal.text}, ${round}`
}

/** 10 cells of `▰▱` for the part of the context in use, then the percent. */
function ContextMeter({ context }: { context: number }) {
  // A value out of range still gives 10 cells.
  const filled = Math.min(METER_CELLS, Math.max(0, Math.round(context * METER_CELLS)))
  return (
    <text flexShrink={0} fg={color.muted} wrapMode="none">
      <span fg={color.indigo}>{'▰'.repeat(filled)}</span>
      <span fg={color.faint}>{'▱'.repeat(METER_CELLS - filled)}</span>
      {` ${Math.round(context * 100)}%`}
    </text>
  )
}

/**
 * The top row of heddle. From left to right:
 *
 * - `◆ heddle`, then the session title. A long title is cut.
 * - The goal chip: `goal tests pass, round 2 of 20`.
 * - The model and the agent, then `no key` in yellow when `missingKey` is set.
 * - Where the tools run: `local`, or `docker` with the sync state.
 * - The context meter and the cost.
 *
 * Each part shows only when its prop is set.
 *
 * @param props What to show. See `HeaderProps`.
 * @example
 * <Header
 *   title="Fix the failing add test"
 *   model="opus 5.5"
 *   agent="build"
 *   place="docker"
 *   sync="synced"
 *   context={0.41}
 *   cost={0.38}
 * />
 */
export function Header({
  title,
  goal,
  model,
  agent,
  place,
  sync,
  context,
  cost,
  missingKey,
}: HeaderProps) {
  const isSandbox = place === 'docker' && sync !== undefined
  return (
    <box flexDirection="row" gap={2} height={1} flexShrink={0}>
      <text flexShrink={0} wrapMode="none">
        <strong fg={color.indigo}>{glyph.write}</strong>
        <strong fg={color.linen}> heddle</strong>
      </text>
      <text flexGrow={1} flexShrink={1} fg={color.linen} wrapMode="none" truncate>
        {title ?? ''}
      </text>
      {goal ? (
        <text flexShrink={1} fg={color.weld} wrapMode="none" truncate>
          goal <span fg={color.muted}>{goalText(goal)}</span>
        </text>
      ) : null}
      <text flexShrink={0} fg={color.muted} wrapMode="none">
        <span fg={color.linen}>{model}</span>
        {agent ? `  ${agent}` : ''}
      </text>
      {missingKey ? (
        <text flexShrink={0} fg={color.weld} wrapMode="none">
          no key
        </text>
      ) : null}
      <text flexShrink={0} fg={color.muted} wrapMode="none">
        {place}
        {isSandbox ? <span fg={SYNC_COLOR[sync]}>{` ${sync}`}</span> : null}
      </text>
      {context === undefined ? null : <ContextMeter context={context} />}
      {cost === undefined ? null : (
        <text flexShrink={0} fg={color.linen} wrapMode="none">
          {`$${cost.toFixed(2)}`}
        </text>
      )}
    </box>
  )
}
