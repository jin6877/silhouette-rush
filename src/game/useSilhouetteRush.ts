import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createGame,
  defaultConfig,
  stepGame,
  timeToImpact,
  finalScore,
  type GameState,
} from './engine'
import { GameRenderer, type FramingView } from './render'
import {
  WebcamMaskSource,
  FakeMaskSource,
  type MaskSource,
  type CaptureTransform,
} from './maskSource'
import { onModelProgress, getDevice } from './segmentation'
import {
  MASK_W,
  MASK_H,
  POSES,
  erodeMask,
  createMask,
  buildPoseMask,
  maskBounds,
  BODY_FRAME,
  type Mask,
  type MaskBounds,
} from './masks'

export type Status = 'idle' | 'loading' | 'framing' | 'playing' | 'gameover'

// How close (normalized 0..1) the head/feet must sit to their guide lines.
const ALIGN_TOL = 0.06

// Capture-framing (zoom / vertical offset) persistence + limits.
const TRANSFORM_KEY = 'silhouette-rush:transform'
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 2.0
export const OFFSET_MIN = -0.3
export const OFFSET_MAX = 0.3

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v

function loadTransform(): CaptureTransform {
  const fallback: CaptureTransform = { zoom: 1, offsetY: 0, offsetX: 0 }
  try {
    const raw = JSON.parse(localStorage.getItem(TRANSFORM_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return fallback
    return {
      zoom: clamp(Number(raw.zoom) || 1, ZOOM_MIN, ZOOM_MAX),
      offsetY: clamp(Number(raw.offsetY) || 0, OFFSET_MIN, OFFSET_MAX),
      offsetX: clamp(Number(raw.offsetX) || 0, OFFSET_MIN, OFFSET_MAX),
    }
  } catch {
    return fallback
  }
}

/** Where the live body's head/feet sit vs. the pose reference frame. */
function alignmentView(b: MaskBounds | null): FramingView {
  if (!b || !b.present) return { present: false, headOn: false, feetOn: false }
  const headOn = Math.abs(b.top - BODY_FRAME.headY) <= ALIGN_TOL
  // Feet-bottom is clamped at 1.0 by the frame edge, so "on" means "reaches
  // within tolerance of the feet line" (near the bottom).
  const feetOn = b.bottom >= BODY_FRAME.feetY - ALIGN_TOL
  return { present: true, headOn, feetOn }
}

/** One concise, actionable framing instruction. */
function framingHint(b: MaskBounds | null, v: FramingView): string {
  if (!b || !v.present) return '카메라 앞에 서서 전신이 보이게 해주세요'
  if (v.headOn && v.feetOn) return '완벽해요! 아래 시작 버튼을 누르세요'
  const bodyH = b.bottom - b.top
  const targetH = BODY_FRAME.feetY - BODY_FRAME.headY
  if (b.top < BODY_FRAME.headY - ALIGN_TOL) return '줌을 줄이거나 뒤로 — 머리가 위로 잘려요'
  if (bodyH < targetH - 0.1) return '줌을 키우거나 앞으로 — 몸이 프레임을 꽉 채우게'
  if (!v.feetOn) return '발이 아래 선에 닿게 — 줌을 줄이거나 뒤로 물러나요'
  if (!v.headOn) return '머리를 위 선까지 — 줌을 키우거나 앞으로 오세요'
  return '줌 슬라이더로 머리는 위 선, 발은 아래 선에 맞춰요'
}

const BEST_KEY = 'silhouette-rush:best'

export interface Snapshot {
  status: Status
  phase: GameState['phase']
  score: number
  combo: number
  bestCombo: number
  hearts: number
  maxHearts: number
  round: number
  passes: number
  fails: number
  best: number
  poseName: string | null
  timeToImpact: number
  progress: number
  fitting: boolean
  present: boolean
  collisionRatio: number
  fillRatio: number
  fps: number
  // Framing step (status === 'framing')
  headAligned: boolean
  feetAligned: boolean
  framingHint: string
}

interface Runtime {
  source: MaskSource
  state: GameState | null // created when play begins (null during framing)
  renderer: GameRenderer
  raf: number
  lastT: number
  dpr: number
  fakeMatte: HTMLCanvasElement | null
  lastMatte: HTMLCanvasElement | null
  mode: 'framing' | 'playing'
  isFake: boolean
}

function emptySnapshot(best: number): Snapshot {
  return {
    status: 'idle',
    phase: 'ready',
    score: 0,
    combo: 0,
    bestCombo: 0,
    hearts: 3,
    maxHearts: 3,
    round: 0,
    passes: 0,
    fails: 0,
    best,
    poseName: null,
    timeToImpact: 0,
    progress: 0,
    fitting: false,
    present: false,
    collisionRatio: 0,
    fillRatio: 0,
    fps: 0,
    headAligned: false,
    feetAligned: false,
    framingHint: '',
  }
}

export interface SilhouetteRushApi {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  snap: Snapshot
  modelProgress: number
  device: string | null
  error: string | null
  /** Raw underlying failure message (worker/engine), shown as a small detail. */
  errorDetail: string | null
  start: (opts?: { fake?: boolean; framing?: boolean }) => Promise<void>
  /** Leave the framing step and start the round (explicit button / skip). */
  startGame: () => void
  restart: () => void
  quit: () => void
  getLastMatte: () => HTMLCanvasElement | null
  /** Live capture framing (zoom / vertical offset) + controls. */
  transform: CaptureTransform
  setZoom: (zoom: number) => void
  setOffsetY: (offsetY: number) => void
  /** Measure the live silhouette and snap zoom/offset so head+feet hit the lines. */
  autoFit: () => void
  resetTransform: () => void
}

export function useSilhouetteRush(): SilhouetteRushApi {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rt = useRef<Runtime | null>(null)
  const [best, setBest] = useState(0)
  const [snap, setSnap] = useState<Snapshot>(() => emptySnapshot(0))
  const [modelProgress, setModelProgress] = useState(0)
  const [device, setDevice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const lastOptsRef = useRef<{ fake?: boolean } | undefined>(undefined)

  // Capture framing (zoom/offset). Restored from localStorage; a ref mirrors it
  // so imperative callbacks (autoFit, source (re)start) read the live value.
  const [transform, setTransform] = useState<CaptureTransform>(() => loadTransform())
  const transformRef = useRef(transform)

  useEffect(() => {
    const raw = Number(localStorage.getItem(BEST_KEY) || '0')
    const b = Number.isNaN(raw) ? 0 : raw
    setBest(b)
    setSnap((s) => ({ ...s, best: b }))
  }, [])

  useEffect(() => onModelProgress((p) => setModelProgress(p)), [])

  // Whenever the framing transform changes, persist it AND push it straight into
  // the live source instance so the very next captured frame is zoomed. This is
  // the link that makes the slider actually move the silhouette.
  useEffect(() => {
    transformRef.current = transform
    try {
      localStorage.setItem(TRANSFORM_KEY, JSON.stringify(transform))
    } catch {
      /* ignore quota/private-mode */
    }
    rt.current?.source.setTransform?.(transform)
  }, [transform])

  const setZoom = useCallback((zoom: number) => {
    setTransform((t) => ({ ...t, zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) }))
  }, [])

  const setOffsetY = useCallback((offsetY: number) => {
    setTransform((t) => ({ ...t, offsetY: clamp(offsetY, OFFSET_MIN, OFFSET_MAX) }))
  }, [])

  const resetTransform = useCallback(() => {
    setTransform({ zoom: 1, offsetY: 0, offsetX: 0 })
  }, [])

  /**
   * Measure where the live silhouette's head/feet currently sit (through the
   * transform already in effect) and solve for the zoom+offset that lands the
   * body's head on the head line and feet on the feet line — a one-tap framing.
   * Works from the current transform so it composes correctly even after manual
   * slider tweaks. (Scale about centre + normalized offset is affine, so this is
   * a direct algebraic solve, clamped to the slider range.)
   */
  const autoFit = useCallback(() => {
    const r = rt.current
    if (!r) return
    const mask = r.source.read()
    const b = mask ? maskBounds(mask) : null
    if (!b || !b.present) return
    const t = transformRef.current
    const dispH = b.bottom - b.top
    if (dispH < 0.02) return
    const targetH = BODY_FRAME.feetY - BODY_FRAME.headY
    const zoom = clamp(t.zoom * (targetH / dispH), ZOOM_MIN, ZOOM_MAX)
    // Un-transform the body's centre back to "raw" (centre-relative) coords,
    // then re-place it centred between the two guide lines at the new zoom.
    const rawMidC = ((b.top + b.bottom) / 2 - 0.5 - t.offsetY) / t.zoom
    const targetMid = (BODY_FRAME.headY + BODY_FRAME.feetY) / 2
    const offsetY = clamp(targetMid - 0.5 - rawMidC * zoom, OFFSET_MIN, OFFSET_MAX)
    const rawCxC = (b.centerX - 0.5 - (t.offsetX ?? 0)) / t.zoom
    const offsetX = clamp(-rawCxC * zoom, OFFSET_MIN, OFFSET_MAX)
    setTransform({ zoom, offsetY, offsetX })
  }, [])

  const stop = useCallback(() => {
    if (rt.current) {
      cancelAnimationFrame(rt.current.raf)
      rt.current.source.stop()
      rt.current = null
    }
  }, [])

  const sizeCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    return dpr
  }, [])

  const commitGameOver = useCallback((state: GameState) => {
    const fs = finalScore(state)
    setBest((prev) => {
      const next = Math.max(prev, fs)
      localStorage.setItem(BEST_KEY, String(next))
      return next
    })
  }, [])

  /** Transition from the framing step into an actual round. */
  const beginPlay = useCallback(() => {
    const r = rt.current
    if (!r || r.mode === 'playing') return
    r.renderer.reset()
    r.state = createGame(defaultConfig(), (Date.now() & 0xffffffff) >>> 0)
    r.mode = 'playing'
    setSnap((s) => ({ ...emptySnapshot(s.best), status: 'playing', best: s.best }))
  }, [])

  const loop = useCallback(
    (now: number) => {
      const r = rt.current
      const canvas = canvasRef.current
      if (!r || !canvas) return
      const dt = Math.min(0.05, (now - r.lastT) / 1000 || 0)
      r.lastT = now

      const mask = r.source.read()

      // Resolve a matte canvas for rendering (real source provides one; for the
      // fake source we synthesize one from the injected mask).
      let matte = r.source.matteCanvas ?? null
      if (!matte && mask) {
        matte = paintMaskToCanvas(mask, r.fakeMatte)
        r.fakeMatte = matte
      }
      if (matte && matte.width > 0) r.lastMatte = matte

      // Resize backing store if needed.
      const rect = canvas.getBoundingClientRect()
      const needW = Math.round(rect.width * r.dpr)
      const needH = Math.round(rect.height * r.dpr)
      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = Math.max(1, needW)
        canvas.height = Math.max(1, needH)
      }

      const ctx = canvas.getContext('2d')!

      // --- Framing step: align head/feet to the guide lines before playing ---
      if (r.mode === 'framing') {
        const b = mask ? maskBounds(mask) : null
        const view = alignmentView(b)
        r.renderer.drawFraming(ctx, r.lastMatte, view, dt, rect.width, rect.height, r.dpr)

        setSnap((s) => ({
          ...s,
          status: 'framing',
          phase: 'ready',
          present: view.present,
          headAligned: view.headOn,
          feetAligned: view.feetOn,
          framingHint: framingHint(b, view),
          fps: (r.source as { fps?: number }).fps ?? 0,
        }))

        // No auto-start: the round begins only when the player clicks 시작
        // (beginPlay), so nobody is thrown into a round before they're ready.
        r.raf = requestAnimationFrame(loop)
        return
      }

      // --- Playing ---
      const st = r.state!
      if (st.phase !== 'gameover') {
        stepGame(st, mask, dt)
        r.renderer.handleEvents(st.events, rect.width, rect.height)
        for (const e of st.events) {
          if (e.type === 'gameover') commitGameOver(st)
        }
      }

      r.renderer.draw(ctx, st, r.lastMatte, dt, rect.width, rect.height, r.dpr)

      // Publish snapshot for the HUD.
      setSnap((s) => ({
        ...s,
        status: st.phase === 'gameover' ? 'gameover' : 'playing',
        phase: st.phase,
        score: st.score,
        combo: st.combo,
        bestCombo: st.bestCombo,
        hearts: st.hearts,
        maxHearts: st.maxHearts,
        round: st.round,
        passes: st.passes,
        fails: st.fails,
        poseName: st.wall?.pose.name ?? null,
        timeToImpact: timeToImpact(st),
        progress: st.wall?.progress ?? 0,
        fitting: st.live.fitting,
        present: st.live.present,
        collisionRatio: st.live.collisionRatio,
        fillRatio: st.live.fillRatio,
        fps: (r.source as { fps?: number }).fps ?? 0,
      }))

      r.raf = requestAnimationFrame(loop)
    },
    [commitGameOver],
  )

  const begin = useCallback(
    async (opts?: { fake?: boolean; framing?: boolean }) => {
      const canvas = canvasRef.current
      if (!canvas) return
      lastOptsRef.current = opts
      setError(null)
      setErrorDetail(null)
      setModelProgress(opts?.fake ? 1 : 0)

      const source: MaskSource = opts?.fake ? new FakeMaskSource() : new WebcamMaskSource('user')
      // Seed the source with the restored/last framing so the first frame is
      // already zoomed the way the player left it.
      source.setTransform?.(transformRef.current)

      if (!opts?.fake) {
        setSnap((s) => ({ ...s, status: 'loading' }))
        // start() acquires the camera AND loads the segmentation worker/model
        // (driving the progress bar). Classify the failure for a helpful message.
        try {
          await source.start()
        } catch (e) {
          const name = (e as DOMException)?.name
          const rawMessage = (e as Error)?.message ?? String(e)
          // Always log the real cause so failures are diagnosable from devtools.
          console.error('[silhouette-rush] start() failed:', e)
          if (name === 'NotAllowedError' || name === 'SecurityError') {
            setError('카메라 권한이 거부됐어요. 주소창의 카메라 아이콘에서 허용해 주세요.')
            setErrorDetail(null)
          } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
            setError('카메라를 찾을 수 없어요. 웹캠을 연결한 뒤 다시 시도해 주세요.')
            setErrorDetail(null)
          } else {
            // Segmentation-engine failures: surface the underlying worker/engine
            // message so the real cause is visible on screen, not just in logs.
            setError('실루엣 인식 엔진을 불러오지 못했어요. 네트워크(카메라·모델 CDN)를 확인해 주세요.')
            setErrorDetail(rawMessage || null)
          }
          setSnap((s) => ({ ...s, status: 'idle' }))
          source.stop()
          return
        }
        try {
          setDevice(await getDevice())
        } catch {
          /* device label is best-effort */
        }
      } else {
        await source.start()
      }

      const dpr = sizeCanvas(canvas)
      const renderer = new GameRenderer()
      renderer.reset()

      // Real webcam always goes through the framing step; the demo goes straight
      // to play unless a framing screenshot is explicitly requested.
      const useFraming = !opts?.fake || !!opts?.framing

      rt.current = {
        source,
        state: useFraming
          ? null
          : createGame(defaultConfig(), (Date.now() & 0xffffffff) >>> 0),
        renderer,
        raf: 0,
        lastT: performance.now(),
        dpr,
        fakeMatte: null,
        lastMatte: null,
        mode: useFraming ? 'framing' : 'playing',
        isFake: !!opts?.fake,
      }
      setSnap((s) => ({
        ...emptySnapshot(s.best),
        status: useFraming ? 'framing' : 'playing',
        best: s.best,
      }))
      rt.current.raf = requestAnimationFrame(loop)
    },
    [loop, sizeCanvas],
  )

  const start = useCallback(
    (opts?: { fake?: boolean; framing?: boolean }) => {
      stop()
      return begin(opts)
    },
    [begin, stop],
  )

  const restart = useCallback(() => {
    start(lastOptsRef.current)
  }, [start])

  const quit = useCallback(() => {
    stop()
    setSnap((s) => ({ ...emptySnapshot(s.best) }))
  }, [stop])

  const getLastMatte = useCallback(() => rt.current?.lastMatte ?? null, [])

  useEffect(() => () => stop(), [stop])

  // Keep the HUD's best in sync.
  useEffect(() => {
    setSnap((s) => ({ ...s, best }))
  }, [best])

  // --- Test / demo hooks for headless verification (Playwright) ---
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    const fitMaskForWall = (): Mask | null => {
      const st = rt.current?.state
      if (!st?.wall) return null
      return erodeMask(st.wall.holeMask, 2)
    }
    const missMask = (): Mask => {
      const m = createMask()
      for (let y = Math.floor(0.05 * MASK_H); y < Math.floor(0.98 * MASK_H); y++)
        for (let x = 0; x < Math.floor(0.3 * MASK_W); x++) m.data[y * MASK_W + x] = 255
      return m
    }
    w.__silhouetteRush = {
      startFake: () => start({ fake: true }),
      // Enter the framing step with a fake source, injecting a body silhouette so
      // the guide lines + alignment feedback are visible for screenshots.
      startFakeFraming: async (kind?: string) => {
        await start({ fake: true, framing: true })
        const s = rt.current?.source
        if (!(s instanceof FakeMaskSource)) return
        const pose =
          kind === 'low'
            ? POSES.find((p) => p.id === 'crouch') ?? POSES[0]
            : POSES[0] // 'stand' — aligned to the reference frame
        s.setMask(buildPoseMask(pose))
      },
      beginPlay: () => beginPlay(),
      // Framing-transform hooks so headless verification can prove the slider is
      // wired to the live pipeline (change zoom → body bounds actually change).
      setZoom: (z: number) => setZoom(z),
      setOffsetY: (o: number) => setOffsetY(o),
      autoFit: () => autoFit(),
      resetTransform: () => resetTransform(),
      getTransform: () => ({ ...transformRef.current }),
      getBounds: () => {
        const m = rt.current?.source.read()
        return m ? maskBounds(m) : null
      },
      setFit: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(fitMaskForWall())
      },
      setMiss: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(missMask())
      },
      setNone: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(null)
      },
      autopilot: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(fitMaskForWall())
      },
      state: () => {
        const st = rt.current?.state
        return {
          phase: st?.phase ?? null,
          score: st?.score ?? 0,
          combo: st?.combo ?? 0,
          hearts: st?.hearts ?? 0,
          round: st?.round ?? 0,
          passes: st?.passes ?? 0,
          fails: st?.fails ?? 0,
          hasWall: !!st?.wall,
          progress: st?.wall?.progress ?? 0,
          poseName: st?.wall?.pose.name ?? null,
        }
      },
    }
    return () => {
      delete w.__silhouetteRush
    }
  }, [start, beginPlay, setZoom, setOffsetY, autoFit, resetTransform])

  return {
    canvasRef,
    snap,
    modelProgress,
    device,
    error,
    errorDetail,
    start,
    startGame: beginPlay,
    restart,
    quit,
    getLastMatte,
    transform,
    setZoom,
    setOffsetY,
    autoFit,
    resetTransform,
  }
}

function paintMaskToCanvas(mask: Mask, reuse: HTMLCanvasElement | null): HTMLCanvasElement {
  const c = reuse ?? document.createElement('canvas')
  if (c.width !== mask.width || c.height !== mask.height) {
    c.width = mask.width
    c.height = mask.height
  }
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(mask.width, mask.height)
  for (let i = 0; i < mask.data.length; i++) {
    img.data[i * 4] = 255
    img.data[i * 4 + 1] = 255
    img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = mask.data[i]
  }
  ctx.putImageData(img, 0, 0)
  return c
}
