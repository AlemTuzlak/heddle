// The frames of a video, for the preview in the session pane. heddle runs
// ffprobe and ffmpeg for them, so they must be on the PATH.

/** The frames per second of a preview. */
export const PREVIEW_FPS = 10

/** The height of a preview frame, in pixels. The width keeps the shape of the video. */
const FRAME_HEIGHT = 144

/** A preview plays at most this many seconds of a video. */
const MAX_SECONDS = 20

/** Small frames of a video: RGBA pixels, `width` × `height` each. */
export interface VideoFrames {
  width: number
  height: number
  frames: Array<Uint8Array>
}

/** ffprobe or ffmpeg is not on the PATH. */
export class NoFfmpegError extends Error {
  constructor() {
    super('Install ffmpeg to play the video.')
    this.name = 'NoFfmpegError'
  }
}

/** Starts `command`. Bun throws when the program is not on the PATH. */
function start(command: Array<string>, signal?: AbortSignal) {
  try {
    // With `env`, Bun finds the program on the PATH of now, not of the start of heddle.
    return Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', signal, env: process.env })
  } catch {
    throw new NoFfmpegError()
  }
}

/** The output of `command`. It throws {@link NoFfmpegError} when the program is missing, and an `Error` when it fails. */
async function output(command: Array<string>, signal?: AbortSignal) {
  const child = start(command, signal)
  const [bytes, errors, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} could not read the video: ${errors.trim()}`)
  return bytes
}

/**
 * Reads the first 20 seconds of the video `path` as small frames, 10 for each
 * second, each 144 pixels high.
 *
 * ponytail: all the frames stay in memory while the preview shows, about
 * 150 KB each for a 16:9 video. Stream them if long videos come.
 *
 * @throws NoFfmpegError when ffprobe or ffmpeg is not on the PATH.
 * @throws Error when the file is not a video that ffmpeg can read.
 * @example
 * const { width, height, frames } = await readFrames('heddle-media/artifact-1.mp4')
 * const first = NativeImage.fromRgba(frames[0], width, height)
 */
export async function readFrames(path: string, signal?: AbortSignal) {
  const probe = await output(
    ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
    signal,
  )
  const [sourceWidth = 0, sourceHeight = 0] = new TextDecoder().decode(probe).trim().split(',').map(Number)
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error(`ffprobe found no video in ${path}.`)
  const height = FRAME_HEIGHT
  // ffmpeg wants an even width.
  const width = Math.max(2, Math.round((sourceWidth / sourceHeight) * height / 2) * 2)
  const raw = await output(
    [
      'ffmpeg', '-v', 'error', '-t', String(MAX_SECONDS), '-i', path,
      '-vf', `fps=${PREVIEW_FPS},scale=${width}:${height}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ],
    signal,
  )
  const size = width * height * 4
  const frames: Array<Uint8Array> = []
  for (let offset = 0; offset + size <= raw.length; offset += size) frames.push(raw.subarray(offset, offset + size))
  const video: VideoFrames = { width, height, frames }
  return video
}
