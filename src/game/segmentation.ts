// Segmentation engine: owns the segmentation Web Worker and the model download.
//
// We replaced the heavy MODNet matting model (run on the main thread via
// transformers.js) with MediaPipe's Selfie Segmenter, a video-optimized model
// that runs at 30-60fps in a background worker. This module only handles the
// one-time setup — downloading the model with real progress, spinning up the
// worker, and exposing a `segment()` call that ships a frame to the worker and
// resolves with the resulting masks. Inference itself never touches this thread.

// Model + wasm are fetched from CDNs (no server, no API keys) — matches the
// prior static-deploy story. Version is pinned to the installed package below.
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
  /** Ship one frame to the worker; resolves with masks (or rejects on drop). */
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

class WorkerEngine implements Engine {
  readonly device: EngineDevice
  private worker: Worker
  private pending = new Map<
    number,
    { resolve: (r: SegResult) => void; reject: (e: Error) => void }
  >()
  private nextId = 1

  constructor(worker: Worker, device: EngineDevice) {
    this.worker = worker
    this.device = device
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data
      if (msg?.type === 'result') {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.resolve({ grid: msg.grid, matte: msg.matte, mw: msg.mw, mh: msg.mh })
        }
      } else if (msg?.type === 'frameError') {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.reject(new Error('frame dropped'))
        }
      }
    }
  }

  segment(bitmap: ImageBitmap, timestamp: number): Promise<SegResult> {
    const id = this.nextId++
    return new Promise<SegResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ type: 'frame', id, bitmap, timestamp }, [bitmap])
    })
  }
}

async function loadEngine(): Promise<Engine> {
  const worker = new Worker(new URL('./segWorker.ts', import.meta.url), { type: 'module' })

  // Model download → real byte progress mapped to 0..0.55 of the bar.
  const modelBuffer = await fetchWithProgress(MODEL_URL, (f) => emitProgress(f * 0.55))

  // Wasm fetch + delegate compile has no granular progress; gently creep the
  // bar from 0.55 toward 0.95 so it never looks frozen on the first load.
  let creep = 0.55
  const creepTimer = setInterval(() => {
    creep = Math.min(0.95, creep + (0.95 - creep) * 0.12)
    emitProgress(creep)
  }, 140)

  const device = await new Promise<EngineDevice>((resolve, reject) => {
    const onInit = (e: MessageEvent) => {
      const msg = e.data
      if (msg?.type === 'ready') {
        worker.removeEventListener('message', onInit)
        resolve(msg.device as EngineDevice)
      } else if (msg?.type === 'error') {
        worker.removeEventListener('message', onInit)
        reject(new Error(msg.message || 'segmenter init failed'))
      }
    }
    worker.addEventListener('message', onInit)
    worker.postMessage({ type: 'init', modelBuffer, wasmBase: WASM_BASE }, [modelBuffer])
  }).catch((err) => {
    clearInterval(creepTimer)
    worker.terminate()
    throw err
  })

  clearInterval(creepTimer)
  emitProgress(1)
  return new WorkerEngine(worker, device)
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
