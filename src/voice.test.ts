import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { hasFfmpeg, tempFolder } from './test-utils'
import { capture, createVoice, likelyMicrophones, parseMicrophones, speechStats, wavFile } from './voice'
import type { Logger } from '@tanstack/ai'

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Raw 16 kHz sound: a 440 Hz tone, `seconds` long. `loud(t)` gives the loudness at the time `t`, from 0 to 32767. */
function sound(seconds: number, loud: (time: number) => number) {
  const samples = new Int16Array(Math.round(seconds * 16000))
  samples.forEach((_, index) => {
    const time = index / 16000
    samples[index] = Math.round(loud(time) * Math.sin(2 * Math.PI * 440 * time))
  })
  return new Uint8Array(samples.buffer)
}

test('parseMicrophones reads the audio inputs that ffmpeg lists', () => {
  const output = [
    '[dshow @ 0] "Integrated Camera" (video)',
    '[dshow @ 0] "HDMI (2- Cam Link 4K)" (audio)',
    '[dshow @ 0] "Microphone (HyperX QuadCast)" (audio)',
    '[dshow @ 0]   Alternative name "@device_cm_{33D9A762}"',
  ].join('\n')
  expect(parseMicrophones(output)).toEqual(['HDMI (2- Cam Link 4K)', 'Microphone (HyperX QuadCast)'])
})

test('likelyMicrophones leaves out capture cards and virtual inputs, unless nothing else is left', () => {
  const names = ['HDMI (2- Cam Link 4K)', 'Microphone (HyperX QuadCast)', 'Virtual Microphone (ASUS Utility)']
  expect(likelyMicrophones(names)).toEqual(['Microphone (HyperX QuadCast)'])
  expect(likelyMicrophones(['Virtual Microphone (ASUS Utility)'])).toEqual(['Virtual Microphone (ASUS Utility)'])
})

test('speechStats tells speech from silence and from a steady noise', () => {
  expect(speechStats(sound(1, () => 0))).toEqual({ peak: 0, floor: 0 })
  // Speech goes loud and quiet: 0.3 s of sound, then 0.3 s of near silence.
  const speech = speechStats(sound(2, (time) => (time % 0.6 < 0.3 ? 8000 : 20)))
  expect(speech.peak).toBeGreaterThan(5000)
  expect(speech.floor).toBeLessThan(100)
  // A hum stays as loud all the time.
  const hum = speechStats(sound(2, () => 2000))
  expect(Math.abs(hum.peak - hum.floor)).toBeLessThan(10)
})

test('wavFile makes a 16 kHz mono 16-bit WAV file', () => {
  const pcm = new Uint8Array([1, 2, 3, 4])
  const file = wavFile(pcm)
  const view = new DataView(file.buffer)
  const text = (start: number) => new TextDecoder().decode(file.subarray(start, start + 4))
  expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
  expect(view.getUint16(22, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(16000)
  expect(view.getUint16(34, true)).toBe(16)
  expect(view.getUint32(40, true)).toBe(4)
  expect(file.subarray(44)).toEqual(pcm)
})

test.skipIf(!hasFfmpeg)('capture records until stop, and shows the loudness while it records', async () => {
  const tone = capture(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000'], 'a test tone')
  await Bun.sleep(600)
  expect(tone.isRunning()).toBe(true)
  expect(tone.level()).toBeGreaterThan(1000)
  await tone.stop()
  expect(tone.isRunning()).toBe(false)
  // ffmpeg makes the tone faster than real time, so there is at least 0.5 s of sound.
  expect(tone.pcm().byteLength).toBeGreaterThan(16000)
  expect(speechStats(tone.pcm()).peak).toBeGreaterThan(1000)
})

test('the microphone choice stays after a restart', () => {
  using folder = tempFolder()
  const file = join(folder.path, 'voice.json')
  const keys = async () => ({})
  createVoice({ file, logger: silent, keys }).choose('Microphone (HyperX QuadCast)')
  expect(createVoice({ file, logger: silent, keys }).microphone()).toBe('Microphone (HyperX QuadCast)')
})

test('without an OpenAI or xAI key, transcribe says how to add one', async () => {
  using folder = tempFolder()
  const voice = createVoice({ file: join(folder.path, 'voice.json'), logger: silent, keys: async () => ({}) })
  await expect(voice.transcribe(wavFile(new Uint8Array(4)))).rejects.toThrow(
    'Voice input needs an OpenAI or an xAI key. Type /connect openai or /connect grok.',
  )
})

test('without ffmpeg on the PATH, start says so', async () => {
  using folder = tempFolder()
  const voice = createVoice({ file: join(folder.path, 'voice.json'), logger: silent, keys: async () => ({}) })
  voice.choose('Microphone (Test)')
  const path = process.env.PATH
  // A folder with no ffmpeg as the PATH.
  process.env.PATH = folder.path
  try {
    await expect(voice.start()).rejects.toThrow('Voice input needs ffmpeg on the PATH.')
  } finally {
    process.env.PATH = path
  }
})
