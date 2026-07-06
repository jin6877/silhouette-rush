// Pluggable silhouette sources. The game loop only depends on the MaskSource
// interface, so a fake, script-driven source can be injected for automated
// verification without a real webcam or ML model.

import { MASK_W, MASK_H, createMask, type Mask } from './masks'
import { getEngine, type Engine, type SegResult } from './segmentation'

/**
 * Capture-time framing transform. `zoom` scales the incoming camera frame about
 * its center (zoom<1 shrinks the whole body into a padded frame so a person
 * standing close still fits head-to-feet inside the guide lines; zoom>1 crops
 * in for someone far away). `offsetY`/`offsetX` shift the frame (normalized
 * fractions). This is a pure capture *pre-processing* layer applied before
 * segmentation, so the silhouette the game judges and the silhouette drawn on
 * screen move together and the head/feet lines stay meaningful.
 */
export interface CaptureTransform {
  zoom: number
  offsetY: number
  offsetX?: number
}

export interface MaskSource {
  start(): Promise<void>
  /** Latest silhouette mask (MASK_W x MASK_H), or null if none yet. */
  read(): Mask | null
  stop(): void
  /** Adjust the capture framing (zoom / vertical + horizontal offset). */
  setTransform?(t: CaptureTransform): void
  /** Optional: a canvas holding the current alpha matte for glow rendering. */
  readonly matteCanvas?: HTMLCanvasElement | null
  readonly fps?: number
}

/**
 * Resample a mask through the same zoom+offset transform the webcam applies to
 * its capture canvas (scale about center + normalized offset). Used by the fake
 * source so headless verification exercises the exact framing math. Nearest
 * neighbour is plenty at grid resolution and stays allocation-cheap.
 */
export function transformMask(
  src: Mask,
  zoom: number,
  offsetY: number,
  offsetX = 0,
): Mask {
  const { width: w, height: h } = src
  const out = createMask(w, h)
  const cx = w / 2
  const cy = h / 2
  const offX = offsetX * w
  const offY = offsetY * h
  const inv = 1 / zoom
  for (let y = 0; y < h; y++) {
    const sy = Math.round((y - cy - offY) * inv + cy)
    if (sy < 0 || sy >= h) continue
    const srow = sy * w
    const drow = y * w
    for (let x = 0; x < w; x++) {
      const sx = Math.round((x - cx - offX) * inv + cx)
      if (sx < 0 || sx >= w) continue
      out.data[drow + x] = src.data[srow + sx]
    }
  }
  return out
}

// Processing resolution — the frame we hand to the segmenter. Small enough that
// MediaPipe stays comfortably real-time; 4:3 to match a typical webcam.
const WORK_W = 256
const WORK_H = 192

// Temporal smoothing time-constants (seconds). Small = responsive. The mask
// (used for judgment) is kept snappy; the matte (visual glow) is a touch softer
// so it flows smoothly between segmentation updates instead of stepping.
const TAU_MASK = 0.045
const TAU_MATTE = 0.06
const BODY_THRESHOLD = 120 // EMA value (0..255) above which a cell counts as body

/**
 * Real webcam source. Each webcam frame is drawn mirrored (selfie view) into a
 * small work canvas and handed to the segmenter (which runs on the main thread).
 * We only ever process the *latest* frame (drop anything that arrives while an
 * inference is in flight) so latency never accumulates, and we temporally smooth
 * the result so the silhouette flows even between updates. The camera image
 * never leaves the device.
 */
export class WebcamMaskSource implements MaskSource {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private work: HTMLCanvasElement | OffscreenCanvas
  private workCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  private matte: HTMLCanvasElement
  private engine: Engine | null = null
  private running = false
  private inFlight = false
  private timestamp = 0
  private rafId = 0

  // Segmentation result targets (updated whenever a frame comes back).
  private targetGrid: Uint8Array | null = null
  private targetMatte: Uint8Array | null = null
  private matteW = 0
  private matteH = 0

  // EMA accumulators + outputs.
  private gridEMA = new Float32Array(MASK_W * MASK_H)
  private matteEMA: Float32Array | null = null
  private matteImage: ImageData | null = null
  private latest: Mask | null = null
  private lastAdvance = 0

  // FPS of the segmentation pipeline (updates/sec).
  private frameCount = 0
  private lastFpsT = 0
  private _fps = 0

  // Capture framing (applied to the work canvas before segmentation, so the
  // judged grid AND the visual matte inherit it identically).
  private zoom = 1
  private offsetY = 0
  private offsetX = 0

  private readonly facingMode: 'user' | 'environment'

  constructor(facingMode: 'user' | 'environment' = 'user') {
    this.facingMode = facingMode
    // Prefer an OffscreenCanvas (zero-copy `transferToImageBitmap`); fall back
    // to a regular canvas where OffscreenCanvas isn't available.
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(WORK_W, WORK_H)
      this.work = c
      this.workCtx = c.getContext('2d')!
    } else {
      const c = document.createElement('canvas')
      c.width = WORK_W
      c.height = WORK_H
      this.work = c
      this.workCtx = c.getContext('2d')!
    }
    this.matte = document.createElement('canvas')
    this.matte.width = WORK_W
    this.matte.height = WORK_H
  }

  get matteCanvas() {
    return this.matte
  }
  get fps() {
    return this._fps
  }

  setTransform(t: CaptureTransform) {
    this.zoom = t.zoom
    this.offsetY = t.offsetY
    this.offsetX = t.offsetX ?? 0
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: this.facingMode,
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
    this.stream = stream
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    await video.play()
    this.video = video

    // Load the segmenter + model on the main thread (emits progress). Throws on
    // failure so the caller can surface a model-load error.
    this.engine = await getEngine()

    this.running = true
    this.lastAdvance = performance.now()
    this.lastFpsT = performance.now()
    this.scheduleFrame()
  }

  /** Segment the latest webcam frame, dropping frames while one is in flight. */
  private scheduleFrame() {
    const video = this.video
    if (!this.running || !video) return
    const onFrame = () => {
      if (!this.running) return
      if (this.engine && !this.inFlight && video.readyState >= 2) {
        void this.processFrame()
      }
      this.scheduleFrame()
    }
    const v = video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => number
    }
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback(onFrame)
    } else {
      this.rafId = requestAnimationFrame(onFrame)
    }
  }

  private async processFrame() {
    const video = this.video
    const engine = this.engine
    if (!video || !engine) return
    this.inFlight = true
    try {
      const ctx = this.workCtx
      ctx.save()
      // Clear first — with zoom-out the frame is padded and old pixels must go.
      ctx.clearRect(0, 0, WORK_W, WORK_H)
      // Zoom + offset about the frame centre, then mirror for a selfie view.
      ctx.translate(WORK_W / 2 + this.offsetX * WORK_W, WORK_H / 2 + this.offsetY * WORK_H)
      ctx.scale(this.zoom, this.zoom)
      ctx.translate(-WORK_W / 2, -WORK_H / 2)
      ctx.translate(WORK_W, 0)
      ctx.scale(-1, 1)
      ctx.drawImage(video, 0, 0, WORK_W, WORK_H)
      ctx.restore()

      const bitmap =
        'transferToImageBitmap' in this.work
          ? (this.work as OffscreenCanvas).transferToImageBitmap()
          : await createImageBitmap(this.work as HTMLCanvasElement)

      this.timestamp = Math.max(Math.round(performance.now()), this.timestamp + 1)
      const res = await engine.segment(bitmap, this.timestamp)
      if (!this.running) return
      this.applyResult(res)
      this.countFps()
    } catch {
      // Dropped/failed frame — just skip it.
    } finally {
      this.inFlight = false
    }
  }

  private applyResult(res: SegResult) {
    this.targetGrid = res.grid
    this.targetMatte = res.matte
    if (this.matteW !== res.mw || this.matteH !== res.mh || !this.matteEMA) {
      this.matteW = res.mw
      this.matteH = res.mh
      this.matteEMA = new Float32Array(res.mw * res.mh)
      this.matte.width = res.mw
      this.matte.height = res.mh
      this.matteImage = this.matte.getContext('2d')!.createImageData(res.mw, res.mh)
    }
  }

  private countFps() {
    this.frameCount++
    const now = performance.now()
    if (now - this.lastFpsT > 500) {
      this._fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsT))
      this.frameCount = 0
      this.lastFpsT = now
    }
  }

  /**
   * Advance the temporal smoothing toward the latest segmentation and repaint
   * the matte. Called once per render frame (from the game loop) so the
   * silhouette stays smooth at 60fps even when updates arrive at ~30.
   */
  private advance() {
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - this.lastAdvance) / 1000))
    this.lastAdvance = now
    if (!this.targetGrid || !this.targetMatte || !this.matteEMA) return

    const kMask = 1 - Math.exp(-dt / TAU_MASK)
    const kMatte = 1 - Math.exp(-dt / TAU_MATTE)

    // Grid EMA → thresholded body mask for judgment.
    const grid = this.targetGrid
    const gema = this.gridEMA
    if (!this.latest) this.latest = createMask()
    const out = this.latest.data
    for (let i = 0; i < gema.length; i++) {
      gema[i] += (grid[i] - gema[i]) * kMask
      out[i] = gema[i] > BODY_THRESHOLD ? 255 : 0
    }

    // Matte EMA → soft alpha for the neon glow, repainted every frame.
    const matte = this.targetMatte
    const mema = this.matteEMA
    const img = this.matteImage!
    const dst = img.data
    for (let i = 0; i < mema.length; i++) {
      mema[i] += (matte[i] - mema[i]) * kMatte
      const j = i * 4
      dst[j] = 255
      dst[j + 1] = 255
      dst[j + 2] = 255
      dst[j + 3] = mema[i]
    }
    this.matte.getContext('2d')!.putImageData(img, 0, 0)
  }

  read(): Mask | null {
    if (!this.running) return this.latest
    this.advance()
    return this.latest
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.stream?.getTracks().forEach((t) => t.stop())
    if (this.video) {
      this.video.srcObject = null
      this.video = null
    }
    this.stream = null
    this.latest = null
    this.targetGrid = null
    this.targetMatte = null
    this.gridEMA.fill(0)
    this.matteEMA = null
  }
}

/**
 * Script-driven source for tests / demos. Inject a mask with `setMask`;
 * `read()` returns the most recently set mask.
 */
export class FakeMaskSource implements MaskSource {
  private mask: Mask | null = null
  private zoom = 1
  private offsetY = 0
  private offsetX = 0
  readonly matteCanvas = null
  async start(): Promise<void> {
    /* no-op */
  }
  read(): Mask | null {
    if (!this.mask) return null
    if (this.zoom === 1 && this.offsetY === 0 && this.offsetX === 0) return this.mask
    return transformMask(this.mask, this.zoom, this.offsetY, this.offsetX)
  }
  stop(): void {
    this.mask = null
  }
  setMask(mask: Mask | null) {
    this.mask = mask
  }
  setTransform(t: CaptureTransform) {
    this.zoom = t.zoom
    this.offsetY = t.offsetY
    this.offsetX = t.offsetX ?? 0
  }
}
