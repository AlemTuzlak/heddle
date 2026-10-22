// Voice input: ffmpeg records the microphone, and a transcription model
// writes down the words. heddle needs ffmpeg on the PATH for it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateTranscription } from '@tanstack/ai'
import { createGrokTranscription } from '@tanstack/ai-grok'
import { createOpenaiTranscription } from '@tanstack/ai-openai'
import { isRecord } from './utils'
import type { Logger } from '@tanstack/ai'

/** The samples per second of a recording: 16 kHz mono, 16 bits. */
const RATE = 16000

/** A microphone that opens stays running. One that does not open stops in this time. */
const OPEN_MS = 400

/** A clip whose loud part is quieter than this is silent, for example from a muted microphone. */
const SILENT_PEAK = 300

/** Inputs that are often silent: capture cards, virtual inputs, and the sound of the computer. */
const NOT_A_MICROPHONE = /hdmi|cam link|virtual|stereo mix|line in/i

/** The thread id of the transcription calls. heddle keeps no record of them. */
const VOICE_THREAD = 'heddle-voice'

/** The text when ffmpeg is not on the PATH. */
const NO_FFMPEG = 'Voice input needs ffmpeg on the PATH.'

/** A recording that runs. */
export interface Recording {
  /** The microphone, or `all microphones` while the first recording picks one. */
  microphone: string
  /** The loudness now, from 0 to 32768, for a level meter. */
  level(): number
  /** Stops, and gives the clip. */
  stop(): Promise<VoiceClip>
  /** Stops, and drops the sound. */
  cancel(): void
}

/** Voice input, as the app uses it. Make it with {@link createVoice}. */
export interface Voice {
  /** The microphones of the computer, from ffmpeg. Empty on macOS and Linux, which record the default input. */
  microphones(): Promise<ReadonlyArray<string>>
  /** The microphone that heddle records, or `undefined` before one is picked. */
  microphone(): string | undefined
  /** Records with the microphone `name` from now on, also after a restart. */
  choose(name: string): void
  /** Starts a recording. It throws when ffmpeg is missing, or when no microphone opens. */
  start(): Promise<Recording>
  /** The words of a WAV file. It throws when there is no key for a transcription model. */
  transcribe(audio: Uint8Array): Promise<string>
}

/** What a recording heard. */
export interface VoiceClip {
  /** A 16 kHz mono WAV file. */
  audio: Uint8Array
  /** True when the clip has no speech, for example from a muted microphone. Do not send it. */
  silent: boolean
  /** The microphone that heard it. */
  microphone: string
}

/**
 * The names of the audio inputs in the output of
 * `ffmpeg -list_devices true -f dshow -i dummy`.
 *
 * @example
 * parseMicrophones('[dshow @ 0] "Microphone (HyperX QuadCast)" (audio)')
 * // ['Microphone (HyperX QuadCast)']
 */
export function parseMicrophones(output: string) {
  return [...output.matchAll(/"([^"]+)" \(audio\)/g)].map((match) => match[1] ?? '')
}

/**
 * The microphones that ffmpeg can record on Windows. Other systems record
 * their default input, so the list is empty there.
 *
 * @throws Error when ffmpeg is not on the PATH.
 */
export async function listMicrophones() {
  if (process.platform !== 'win32') return []
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(['ffmpeg', '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      env: process.env,
    })
  } catch {
    throw new Error(NO_FFMPEG)
  }
  // ffmpeg lists the devices on stderr, then fails because `dummy` is no device.
  const output = await new Response(child.stderr as ReadableStream<Uint8Array>).text()
  await child.exited
  return parseMicrophones(output)
}

/** The microphones of `names` that are worth a try. When none is left, all of them. */
export function likelyMicrophones(names: ReadonlyArray<string>) {
  const real = names.filter((name) => !NOT_A_MICROPHONE.test(name))
  return real.length > 0 ? real : [...names]
}

/** The ffmpeg input arguments of the microphone `name`, or of the default input. */
function microphoneInput(name: string | undefined) {
  if (process.platform === 'win32') return ['-f', 'dshow', '-i', `audio=${name}`]
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', `:${name ?? 'default'}`]
  return ['-f', 'pulse', '-i', name ?? 'default']
}

/** The 16-bit samples of raw sound. An odd last byte is left out. */
function samplesOf(pcm: Uint8Array) {
  return new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)))
}

/** The loudness of the samples: their root mean square, without a constant offset. */
function loudness(samples: Int16Array) {
  if (samples.length === 0) return 0
  let sum = 0
  let squares = 0
  for (const sample of samples) {
    sum += sample
    squares += sample * sample
  }
  const mean = sum / samples.length
  return Math.sqrt(Math.max(0, squares / samples.length - mean * mean))
}

/**
 * How much speech raw 16 kHz sound has, from the loudness of its 100 ms
 * parts: `peak` is the loud part (the 90th percentile), and `floor` is the
 * noise (the 20th percentile). Speech makes the peak much louder than the
 * floor. Steady noise does not.
 */
export function speechStats(pcm: Uint8Array) {
  const samples = samplesOf(pcm)
  const size = RATE / 10
  const parts: Array<number> = []
  for (let start = 0; start + size <= samples.length; start += size) {
    parts.push(loudness(samples.subarray(start, start + size)))
  }
  parts.sort((a, b) => a - b)
  const at = (share: number) => parts[Math.min(parts.length - 1, Math.floor(parts.length * share))] ?? 0
  return { peak: at(0.9), floor: at(0.2) }
}

/** How clearly sound has speech: the peak over the noise floor. */
function clarity(stats: { peak: number; floor: number }) {
  return stats.peak / Math.max(stats.floor, 30)
}

/** A 16 kHz mono 16-bit WAV file of raw sound. */
export function wavFile(pcm: Uint8Array) {
  const header = new DataView(new ArrayBuffer(44))
  const word = (offset: number, text: string) => {
    for (let index = 0; index < 4; index += 1) header.setUint8(offset + index, text.charCodeAt(index))
  }
  word(0, 'RIFF')
  header.setUint32(4, 36 + pcm.byteLength, true)
  word(8, 'WAVE')
  word(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, RATE, true)
  header.setUint32(28, RATE * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  word(36, 'data')
  header.setUint32(40, pcm.byteLength, true)
  const file = new Uint8Array(44 + pcm.byteLength)
  file.set(new Uint8Array(header.buffer))
  file.set(pcm, 44)
  return file
}

/** The ffmpeg processes that record now. They stop when heddle exits, so no microphone stays open. */
const recorders = new Set<{ kill(): void }>()
process.once('exit', () => {
  for (const child of recorders) child.kill()
})

/**
 * One ffmpeg process that records raw 16 kHz sound from `input`, the ffmpeg
 * input arguments. `name` is the name of the input.
 *
 * @throws Error when ffmpeg is not on the PATH.
 * @example
 * const tone = capture(['-f', 'lavfi', '-i', 'sine=frequency=440'], 'a test tone')
 */
export function capture(input: ReadonlyArray<string>, name: string) {
  const command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1']
  let child: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  try {
    child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env })
  } catch {
    throw new Error(NO_FFMPEG)
  }
  recorders.add(child)
  const chunks: Array<Uint8Array> = []
  let level = 0
  let errors = ''
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      chunks.push(chunk)
      level = loudness(samplesOf(chunk))
    }
  })()
  const exited = Promise.all([
    child.exited,
    reading,
    new Response(child.stderr).text().then((text) => {
      errors = text.trim()
    }),
  ]).finally(() => recorders.delete(child))
  return {
    name,
    /** Settles when ffmpeg ended, and its sound and its errors are read. */
    exited,
    isRunning: () => child.exitCode === null,
    errors: () => errors,
    level: () => level,
    pcm: () => new Uint8Array(Buffer.concat(chunks)),
    /** Stops ffmpeg cleanly with `q`, and kills it after 2 s if it does not stop. */
    stop: async () => {
      child.stdin.write('q')
      await child.stdin.end()
      const timer = setTimeout(() => child.kill(), 2000)
      await exited.catch(() => {})
      clearTimeout(timer)
    },
    kill: () => child.kill(),
  }
}

/** The microphone in the saved file, or `undefined`. */
function readChoice(file: string, logger: Logger) {
  if (!existsSync(file)) return undefined
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(saved) && typeof saved.microphone === 'string' ? saved.microphone : undefined
  } catch (error) {
    logger.warn('heddle could not read the saved microphone.', { error })
    return undefined
  }
}

/** The API keys of the transcription models. */
interface TranscriptionKeys {
  openai?: string
  grok?: string
}

/**
 * The voice input of heddle. The microphone choice is saved in `file`.
 *
 * `start()` records until `stop()` or `cancel()`. Before a microphone is
 * picked on Windows, it records on all the microphones that are worth a try,
 * keeps the one that heard speech the clearest, and saves it. On macOS and
 * Linux, it records the default input.
 *
 * `transcribe()` writes down the words with OpenAI `gpt-4o-transcribe` when
 * `keys` gives an OpenAI key, else with xAI `grok-stt`.
 *
 * @example
 * const voice = createVoice({ file: join(home, '.heddle', 'voice.json'), logger, keys })
 * const recording = await voice.start()
 * const clip = await recording.stop()
 * if (!clip.silent) console.log(await voice.transcribe(clip.audio))
 */
export function createVoice({ file, logger, keys }: {
  file: string
  logger: Logger
  /** The keys now: from `/connect`, else from the environment. */
  keys: () => Promise<TranscriptionKeys>
}) {
  let picked = readChoice(file, logger)

  const choose = (name: string) => {
    picked = name
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ microphone: name }))
    } catch (error) {
      logger.warn('heddle could not save the microphone.', { error })
    }
  }

  const start = async () => {
    const isPicking = picked === undefined && process.platform === 'win32'
    const names: Array<string | undefined> = isPicking ? likelyMicrophones(await listMicrophones()) : [picked]
    if (names.length === 0) throw new Error('heddle found no microphone.')
    const captures = names.map((name) => capture(microphoneInput(name), name ?? 'the default input'))
    // ffmpeg stops at once when a microphone does not open.
    await Bun.sleep(OPEN_MS)
    const live = captures.filter((each) => each.isRunning())
    if (live.length === 0) {
      // A microphone that did not open writes why.
      await Promise.all(captures.map((each) => each.exited.catch(() => {})))
      const errors = captures.map((each) => each.errors()).filter((text) => text !== '')
      throw new Error(`The microphone did not open. ${errors.join(' ')}`.trim())
    }
    const recording: Recording = {
      microphone: isPicking && live.length > 1 ? 'all microphones' : (live[0]?.name ?? ''),
      level: () => Math.max(...live.map((each) => each.level())),
      stop: async () => {
        await Promise.all(live.map((each) => each.stop()))
        const heard = live.map((each) => {
          const pcm = each.pcm()
          return { name: each.name, pcm, ...speechStats(pcm) }
        })
        const best = heard.reduce((clearest, each) => (clarity(each) > clarity(clearest) ? each : clearest))
        const silent = best.peak < SILENT_PEAK
        // In silence, the clearest microphone means nothing, so it is not kept.
        if (isPicking && !silent) choose(best.name)
        return { audio: wavFile(best.pcm), silent, microphone: best.name }
      },
      cancel: () => {
        for (const each of live) each.kill()
      },
    }
    return recording
  }

  const voice: Voice = {
    microphones: listMicrophones,
    microphone: () => picked,
    choose,
    start,
    transcribe: async (audio) => transcribe(audio, await keys(), logger),
  }
  return voice
}

/**
 * The words of a WAV file. It throws when there is neither key, or when the
 * model call fails. The error details go to `logger`, not to the terminal.
 */
async function transcribe(audio: Uint8Array, keys: TranscriptionKeys, logger: Logger) {
  const file = new File([audio.slice()], 'voice.wav', { type: 'audio/wav' })
  const options = { audio: file, threadId: VOICE_THREAD, debug: { logger } }
  if (keys.openai !== undefined) {
    const adapter = createOpenaiTranscription('gpt-4o-transcribe', keys.openai)
    const result = await generateTranscription({ adapter, ...options })
    return result.text.trim()
  }
  if (keys.grok !== undefined) {
    const adapter = createGrokTranscription('grok-stt', keys.grok)
    const result = await generateTranscription({ adapter, ...options })
    return result.text.trim()
  }
  throw new Error('Voice input needs an OpenAI or an xAI key. Type /connect openai or /connect grok.')
}
