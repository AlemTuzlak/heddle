import { useRenderer } from '@opentui/react'
import { useEffect, useState } from 'react'
import type { Recording } from '../voice'
import { color } from './theme'

/** What voice input does now: the microphone starts, it records, or the model writes down the words. */
export type VoiceState =
  | { step: 'starting' }
  | { step: 'recording'; recording: Recording }
  | { step: 'writing' }

/** The cells of the level meter. */
const METER_CELLS = 10

/** The meter draws again this often, in ms. */
const METER_MS = 100

/**
 * The level meter of a loudness from 0 to 32768: more full cells for a
 * louder sound. The scale is a log scale, so quiet noise shows no cells and
 * speech fills about half.
 *
 * @example
 * meter(0) // '▯▯▯▯▯▯▯▯▯▯'
 * meter(32768) // '▮▮▮▮▮▮▮▮▮▮'
 */
export function meter(level: number) {
  const share = (Math.log10(1 + level) - 1.5) / 3
  const filled = Math.round(Math.max(0, Math.min(1, share)) * METER_CELLS)
  return '▮'.repeat(filled) + '▯'.repeat(METER_CELLS - filled)
}

/**
 * The line of voice input above the composer, for example
 * `● Recording  ▮▮▮▮▯▯▯▯▯▯  Microphone (HyperX QuadCast)   ctrl+r stop   esc cancel`.
 * The meter moves while it records.
 *
 * @param state What voice input does now.
 * @example
 * {voice === undefined ? null : <VoiceBar state={voice} />}
 */
export function VoiceBar({ state }: { state: VoiceState }) {
  const renderer = useRenderer()
  const [, setTick] = useState(0)
  const isRecording = state.step === 'recording'
  useEffect(() => {
    if (!isRecording) return
    const timer = renderer.clock.setInterval(() => setTick((tick) => tick + 1), METER_MS)
    return () => renderer.clock.clearInterval(timer)
  }, [isRecording, renderer])
  return (
    <box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      {state.step === 'recording' ? (
        <text fg={color.muted} wrapMode="none">
          <span fg={color.madder}>●</span>
          <span fg={color.linen}> Recording  </span>
          <span fg={color.indigo}>{meter(state.recording.level())}</span>
          {`  ${state.recording.microphone}   `}
          <span fg={color.linen}>ctrl+r</span>
          {' stop   '}
          <span fg={color.linen}>esc</span>
          {' cancel'}
        </text>
      ) : (
        <text fg={color.muted} wrapMode="none">
          {state.step === 'starting' ? '◌ Starting the microphone…' : '◌ Writing down your words…'}
        </text>
      )}
    </box>
  )
}
