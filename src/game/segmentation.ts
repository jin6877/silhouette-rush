// Segmentation engine: loads MediaPipe's Selfie Segmenter and runs inference
// ON THE MAIN THREAD.
//
// Why not a Web Worker? MediaPipe's `@mediapipe/tasks-vision` wasm loader
// (`FilesetResolver.forVisionTasks`) registers its Emscripten Module factory via
// `importScripts()`. A *module* worker (`new Worker(url, { type: 'module' })` —
// which Vite emits for TS workers) has no `importScripts`, so the factory is
// never set and `ImageSegmenter.createFromOptions` throws "ModuleFactory not
// set", failing both GPU and CPU delegates → the game bounced back to the start
// screen. Running the segmenter on the main thread sidesteps that entirely, and
// as a bonus the WebGL (GPU) delegate — which was flaky inside the worker and
// always fell back to CPU — works normally here. The Selfie Segmenter is a tiny
// video model, so main-thread inference does not stall the render loop (the old
// heavyweight was MODNet-on-CPU, which no longer exists).
//
// Model + wasm are still fetched from CDNs (no server, no API keys) — the
// static-deploy story is unchanged, and no COOP/COEP headers are needed.

import { ImageSegmenter, FilesetResolver, type MPMask } from '@mediapipe/tasks-vision'
import { MASK_W, MASK_H } from './masks'

// Version is pinned to the installed package.
const TASKS_VISION_VERSION = '0.10.35'
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`
// Selfie Segmenter (general, 256x256) — tiny & tuned for real-time video.
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

export type EngineDevice = 'gpu' | 'cpu'

export interface SegResult {
  /** Soft occupancy grid at game resolution (MASK_W x MASK_H), 0..255. */
  grid: Uint8Array
  /** Full-res alpha matte for the glow, mw x mh, 0..255. */
  matte: Uint8Array
  mw: number
  mh: number
}

export interface Engine {
  device: EngineDevice
  /** Segment one frame on the main thread; resolves with masks (rejects on drop). */
  segment(bitmap: ImageBitmap, timestamp: number): Promise<SegResult>
}

type ProgressListener = (progress: number) => void

let enginePromise: Promise<Engine> | null = null
const progressListeners = new Set<ProgressListener>()

export function onModelProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

function emitProgress(p: number) {
  for (const listener of progressListeners) listener(p)
}

/** Download a binary asset while reporting byte-level progress via `onFraction`. */
async function fetchWithProgress(
  url: string,
  onFraction: (f: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`model fetch failed: ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) {
    // No streaming/length info — fall back to a plain download.
    return res.arrayBuffer()
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onFraction(Math.min(1, loaded / total))
  }
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out.buffer
}

/** Convert an MPMask (single-channel confidence) into a SegResult. */
function convertMask(mask: MPMask): SegResult {
  const w = mask.width
  const h = mask.height
  const conf = mask.getAsFloat32Array() // single channel, ~[0,1], high = person

  // Downsample to the fixed game grid (soft values; EMA/threshold on caller).
  const grid = new Uint8Array(MASK_W * MASK_H)
  for (let gy = 0; gy < MASK_H; gy++) {
    const sy = Math.min(h - 1, ((gy + 0.5) / MASK_H) * h) | 0
    const row = sy * w
    const grow = gy * MASK_W
    for (let gx = 0; gx < MASK_W; gx++) {
      const sx = Math.min(w - 1, ((gx + 0.5) / MASK_W) * w) | 0
      const v = conf[row + sx] * 255
      grid[grow + gx] = v > 255 ? 255 : v < 0 ? 0 : v
    }
  }

  // Full-resolution alpha matte for the neon silhouette glow.
  const matte = new Uint8Array(w * h)
  for (let i = 0; i < matte.length; i++) {
    const v = conf[i] * 255
    matte[i] = v > 255 ? 255 : v < 0 ? 0 : v
  }

  return { grid, matte, mw: w, mh: h }
}

class MainThreadEngine implements Engine {
  readonly device: EngineDevice
  private segmenter: ImageSegmenter

  constructor(segmenter: ImageSegmenter, device: EngineDevice) {
    this.segmenter = segmenter
    this.device = device
  }

  segment(bitmap: ImageBitmap, timestamp: number): Promise<SegResult> {
    return new Promise<SegResult>((resolve, reject) => {
      try {
        // In VIDEO running mode `segmentForVideo` invokes the callback
        // synchronously, and the MPMask is only valid inside it — `convertMask`
        // copies the data out before we return, so it is safe.
        this.segmenter.segmentForVideo(bitmap, timestamp, (result) => {
          const masks = result.confidenceMasks
          if (masks && masks.length > 0) {
            // Single-class Selfie Segmenter: last channel is the foreground.
            resolve(convertMask(masks[masks.length - 1]))
          } else {
            reject(new Error('frame dropped'))
          }
        })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      } finally {
        // Frame consumed — release the bitmap so decode buffers don't pile up.
        bitmap.close()
      }
    })
  }
}

/**
 * Build an ImageSegmenter for a single delegate attempt. Each attempt gets a
 * FRESH clone of the model bytes: MediaPipe consumes/detaches the underlying
 * ArrayBuffer of the `modelAssetBuffer` it is handed, so reusing one buffer for
 * a CPU fallback after a failed GPU try would feed the second call an empty
 * (detached) buffer. Per-attempt clones keep GPU and CPU tries independent.
 */
async function createSegmenter(
  fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  modelBytes: Uint8Array,
  delegate: 'GPU' | 'CPU',
): Promise<ImageSegmenter> {
  const bytes = modelBytes.slice()
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: bytes, delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  })
}

async function initSegmenter(
  modelBuffer: ArrayBuffer,
): Promise<{ segmenter: ImageSegmenter; device: EngineDevice }> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  // Master copy of the model bytes — never handed to MediaPipe directly, so it
  // can't be detached between the GPU and CPU tries.
  const master = new Uint8Array(modelBuffer)

  // Try the GPU (WebGL) delegate first — fastest and, on the main thread, the
  // WebGL context is reliably available. Fall back to CPU if it fails.
  try {
    const segmenter = await createSegmenter(fileset, master, 'GPU')
    console.log('[segmentation] ImageSegmenter ready on main thread via GPU (WebGL) delegate')
    return { segmenter, device: 'gpu' }
  } catch (gpuErr) {
    console.warn(
      '[segmentation] GPU (WebGL) delegate unavailable — falling back to CPU:',
      String((gpuErr as Error)?.message ?? gpuErr),
    )
  }

  try {
    const segmenter = await createSegmenter(fileset, master, 'CPU')
    console.log('[segmentation] ImageSegmenter ready on main thread via CPU delegate')
    return { segmenter, device: 'cpu' }
  } catch (cpuErr) {
    const message = String((cpuErr as Error)?.message ?? cpuErr)
    console.error('[segmentation] CPU delegate also failed — segmenter init failed:', message)
    throw new Error(message)
  }
}

async function loadEngine(): Promise<Engine> {
  // Model download → real byte progress mapped to 0..0.55 of the bar.
  const modelBuffer = await fetchWithProgress(MODEL_URL, (f) => emitProgress(f * 0.55))

  // Wasm fetch + delegate compile has no granular progress; gently creep the
  // bar from 0.55 toward 0.95 so it never looks frozen on the first load.
  let creep = 0.55
  const creepTimer = setInterval(() => {
    creep = Math.min(0.95, creep + (0.95 - creep) * 0.12)
    emitProgress(creep)
  }, 140)

  // Guard against a wedged init (wasm/model fetch or delegate compile that never
  // resolves or rejects) so the UI ends with a clear error rather than a
  // forever-stalled loading bar.
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          'segmenter init timed out after 20s (wasm/model load or delegate compile stalled)',
        ),
      )
    }, 20000)
    // Best-effort: don't keep the event loop alive if the runtime supports it.
    ;(t as unknown as { unref?: () => void }).unref?.()
  })

  let result: { segmenter: ImageSegmenter; device: EngineDevice }
  try {
    result = await Promise.race([initSegmenter(modelBuffer), timeoutPromise])
  } finally {
    clearInterval(creepTimer)
  }

  emitProgress(1)
  return new MainThreadEngine(result.segmenter, result.device)
}

export function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

export async function getDevice(): Promise<EngineDevice> {
  return (await getEngine()).device
}
