import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { hasFfmpeg, redThenBlueVideo, tempFolder } from './test-utils'
import { NoFfmpegError, readFrames } from './video'

/** The red, green, and blue of the pixel at the middle of a frame. */
function middleColor(frame: Uint8Array, width: number, height: number) {
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return [frame[at] ?? 0, frame[at + 1] ?? 0, frame[at + 2] ?? 0]
}

test.skipIf(!hasFfmpeg)('readFrames gives 10 small frames for each second, in the shape of the video', async () => {
  using folder = tempFolder()
  const path = join(folder.path, 'clip.mp4')
  redThenBlueVideo(path)
  const { width, height, frames } = await readFrames(path)
  // 64 × 36 is 16:9, so a frame 144 pixels high is 256 wide.
  expect([width, height]).toEqual([256, 144])
  expect(frames).toHaveLength(10)
  expect(frames.every((frame) => frame.length === 256 * 144 * 4)).toBe(true)
  const [red] = middleColor(frames[0]!, width, height)
  const [, , blue] = middleColor(frames[9]!, width, height)
  expect(red).toBeGreaterThan(200)
  expect(blue).toBeGreaterThan(200)
})

test.skipIf(!hasFfmpeg)('a file that is not a video fails', async () => {
  using folder = tempFolder()
  const path = join(folder.path, 'notes.mp4')
  await Bun.write(path, 'not a video')
  await expect(readFrames(path)).rejects.toThrow('ffprobe could not read the video')
})

test('without ffmpeg on the PATH, readFrames says to install it', async () => {
  using folder = tempFolder()
  const path = process.env.PATH
  // An empty folder as the PATH: Bun finds no ffprobe.
  process.env.PATH = folder.path
  try {
    await expect(readFrames(join(folder.path, 'clip.mp4'))).rejects.toBeInstanceOf(NoFfmpegError)
  } finally {
    process.env.PATH = path
  }
})
