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
  captureCalibration,
  BODY_FRAME,
  type Mask,
  type MaskBounds,
  type Calibration,
} from './masks'

export type Status = 'idle' | 'loading' | 'framing' | 'playing' | 'gameover'

// Framing "가만히 서 있기" calibration countdown.
const COUNT_SECONDS = 3 // hold still this long to capture the standing body
const SAMPLE_WINDOW = 0.6 // average the body bounds over the final N seconds
// A body whose top/bottom touches within this of the frame edge is "cut off"
// — digital zoom can't widen the camera FOV, so we tell the player to move the
// camera rather than zoom, and we refuse to calibrate a cut body.
const CUT_EDGE = 0.02

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

/** Where the live body's head/feet sit and whether the frame edge cuts them. */
function framingView(b: MaskBounds | null): FramingView {
  if (!b || !b.present) {
    return { present: false, top: 0, bottom: 1, headCut: false, feetCut: false }
  }
  return {
    present: true,
    top: b.top,
    bottom: b.bottom,
    headCut: b.top <= CUT_EDGE,
    feetCut: b.bottom >= 1 - CUT_EDGE,
  }
}

/**
 * One concise, actionable framing instruction. The cut-off cases steer the
 * player to move/tilt the CAMERA (digital zoom can't widen the FOV), and zoom is
 * demoted to a secondary aid.
 */
function framingHint(v: FramingView, phase: CalibPhase): string {
  if (!v.present) return '카메라 앞에 서서 온몸이 보이게 서주세요'
  if (v.headCut && v.feetCut)
    return '머리·발이 화면 밖이에요 — 카메라를 더 뒤로 옮겨 온몸이 보이게 하세요 (줌은 보조)'
  if (v.headCut) return '머리가 화면 위로 잘렸어요 — 카메라를 뒤로 옮기거나 위로 기울이세요'
  if (v.feetCut) return '발이 화면 아래로 잘렸어요 — 카메라를 뒤로 옮기거나 아래로 기울이세요'
  if (phase === 'counting') return '가만히 서 있어요… 기준 몸을 잡는 중이에요'
  if (phase === 'done') return '기준 완료! 이제 자유롭게 서서 포즈만 맞추면 통과돼요 · 시작을 누르세요'
  return '좋아요, 몸 전체가 보여요'
}

const BEST_KEY = 'silhouette-rush:best'

export type CalibPhase = 'counting' | 'done'

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
  headCut: boolean
  feetCut: boolean
  calibPhase: CalibPhase
  calibCount: number // countdown number shown while calibrating (0 = none)
  framingReady: boolean // calibration captured → 시작 enabled
  framingHint: string
}

interface CalibRuntime {
  phase: CalibPhase
  startT: number // ms timestamp the current countdown began
  samples: MaskBounds[] // body bounds collected in the final window
  captured: Calibration | null
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
  calib: CalibRuntime
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
    headCut: false,
    feetCut: false,
    calibPhase: 'counting',
    calibCount: 0,
    framingReady: false,
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
  /** Live capture framing (zoom / vertical offset) — a secondary aid now. */
  transform: CaptureTransform
  setZoom: (zoom: number) => void
  setOffsetY: (offsetY: number) => void
  resetTransform: () => void
  /** Restart the "가만히 서 있기" countdown to re-capture the standing body. */
  recalibrate: () => void
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
  // so imperative callbacks (source (re)start) read the live value.
  const [transform, setTransform] = useState<CaptureTransform>(() => loadTransform())
  const transformRef = useRef(transform)
  // Standing-body calibration captured by the framing countdown (mirrors the
  // active runtime capture so beginPlay can seed the game with it).
  const calibrationRef = useRef<Calibration | null>(null)

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

  /** (Re)start the "가만히 서 있기" countdown. Also clears any captured body. */
  const restartCountdown = useCallback(() => {
    const r = rt.current
    if (!r) return
    calibrationRef.current = null
    r.calib = { phase: 'counting', startT: performance.now(), samples: [], captured: null }
  }, [])

  // Changing the capture framing (zoom/offset) moves the whole body in the
  // camera, so any captured standing reference is stale — re-run the countdown.
  const setZoom = useCallback(
    (zoom: number) => {
      setTransform((t) => ({ ...t, zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) }))
      if (rt.current?.mode === 'framing') restartCountdown()
    },
    [restartCountdown],
  )

  const setOffsetY = useCallback(
    (offsetY: number) => {
      setTransform((t) => ({ ...t, offsetY: clamp(offsetY, OFFSET_MIN, OFFSET_MAX) }))
      if (rt.current?.mode === 'framing') restartCountdown()
    },
    [restartCountdown],
  )

  const resetTransform = useCallback(() => {
    setTransform({ zoom: 1, offsetY: 0, offsetX: 0 })
    restartCountdown()
  }, [restartCountdown])

  /** Re-run the standing-body countdown (exposed as "다시 맞추기"). */
  const recalibrate = useCallback(() => {
    restartCountdown()
  }, [restartCountdown])

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
    // Seed the round with the standing body captured in the countdown so pose
    // judgment is normalized to the player's own frame (falls back to a live
    // one-shot capture if they somehow skipped the countdown).
    let cal = r.calib.captured ?? calibrationRef.current
    if (!cal) {
      const b = r.source.read()
      const mb = b ? maskBounds(b) : null
      if (mb?.present) cal = { top: mb.top, bottom: mb.bottom, centerX: mb.centerX }
    }
    r.state = createGame(defaultConfig(), (Date.now() & 0xffffffff) >>> 0, cal ?? null)
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

      // --- Framing step: capture the standing body via a hold-still countdown ---
      if (r.mode === 'framing') {
        const b = mask ? maskBounds(mask) : null
        const view = framingView(b)
        const cut = !view.present || view.headCut || view.feetCut
        const cal = r.calib
        let count = 0

        if (cal.phase === 'counting') {
          if (cut) {
            // Body isn't fully in frame — hold/reset the countdown until it is.
            cal.startT = now
            cal.samples = []
          } else {
            const remain = COUNT_SECONDS - (now - cal.startT) / 1000
            count = Math.max(0, Math.ceil(remain))
            if (remain <= SAMPLE_WINDOW && b?.present) cal.samples.push(b)
            if (remain <= 0) {
              cal.captured = captureCalibration(cal.samples, b)
              cal.phase = 'done'
              calibrationRef.current = cal.captured
            }
          }
        }

        r.renderer.drawFraming(ctx, r.lastMatte, view, dt, rect.width, rect.height, r.dpr)

        setSnap((s) => ({
          ...s,
          status: 'framing',
          phase: 'ready',
          present: view.present,
          headCut: view.headCut,
          feetCut: view.feetCut,
          calibPhase: cal.phase,
          calibCount: count,
          framingReady: cal.phase === 'done',
          framingHint: framingHint(view, cal.phase),
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

      calibrationRef.current = null
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
        calib: { phase: 'counting', startT: performance.now(), samples: [], captured: null },
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
    // Place a canonical mask into the camera frame at `cal` (inverse of the
    // judgment warp) so we can simulate a player who appears small / off to one
    // side / partially in frame while still doing the right pose.
    const placeInCamera = (src: Mask, cal: Calibration): Mask => {
      const out = createMask()
      const s = (BODY_FRAME.feetY - BODY_FRAME.headY) / Math.max(1e-3, cal.bottom - cal.top)
      for (let oy = 0; oy < MASK_H; oy++) {
        const nY = BODY_FRAME.headY + ((oy + 0.5) / MASK_H - cal.top) * s
        const sy = Math.floor(nY * MASK_H)
        if (sy < 0 || sy >= MASK_H) continue
        for (let ox = 0; ox < MASK_W; ox++) {
          const nX = 0.5 + ((ox + 0.5) / MASK_W - cal.centerX) * s
          const sx = Math.floor(nX * MASK_W)
          if (sx < 0 || sx >= MASK_W) continue
          out.data[oy * MASK_W + ox] = src.data[sy * MASK_W + sx]
        }
      }
      return out
    }
    // A stand pose placed at `cal` — the "standing body" the player calibrates on.
    const standAt = (cal: Calibration): Mask => placeInCamera(buildPoseMask(POSES[0]), cal)
    // The current wall's ideal fit, or a wrong pose, placed at the game's calibration.
    const poseAt = (src: Mask | null): Mask => {
      const st = rt.current?.state
      const cal = st?.calibration
      if (!src) return createMask()
      return cal ? placeInCamera(src, cal) : src
    }
    const fitMaskForWall = (): Mask | null => {
      const st = rt.current?.state
      if (!st?.wall) return null
      return poseAt(erodeMask(st.wall.holeMask, 2))
    }
    const missMaskForWall = (): Mask => {
      const st = rt.current?.state
      // A clearly different pose (or a left column when no wall) → collides.
      if (st?.wall) {
        const other = POSES.find((p) => p.id !== st.wall!.pose.id && p.difficulty <= 2) ?? POSES[1]
        return poseAt(erodeMask(buildPoseMask(other), 2))
      }
      const m = createMask()
      for (let y = Math.floor(0.05 * MASK_H); y < Math.floor(0.98 * MASK_H); y++)
        for (let x = 0; x < Math.floor(0.3 * MASK_W); x++) m.data[y * MASK_W + x] = 255
      return m
    }
    const setSourceMask = (m: Mask | null) => {
      const s = rt.current?.source
      if (s instanceof FakeMaskSource) s.setMask(m)
    }
    w.__silhouetteRush = {
      startFake: () => start({ fake: true }),
      // Enter the framing step with a fake source. `cal` places the standing body
      // (small / off-centre / partly cut) so the snapped guides, the countdown,
      // and the cut-off warning are all exercisable for screenshots.
      startFakeFraming: async (cal?: Calibration) => {
        await start({ fake: true, framing: true })
        const s = rt.current?.source
        if (!(s instanceof FakeMaskSource)) return
        s.setMask(standAt(cal ?? { top: 0.16, bottom: 0.92, centerX: 0.5 }))
      },
      // Force the countdown to complete now (deterministic screenshots).
      finishCountdown: () => {
        const r = rt.current
        if (!r || r.mode !== 'framing') return
        const m = r.source.read()
        const b = m ? maskBounds(m) : null
        r.calib.captured = captureCalibration([], b)
        r.calib.phase = 'done'
        calibrationRef.current = r.calib.captured
      },
      recalibrate: () => recalibrate(),
      framingState: () => {
        const r = rt.current
        const m = r?.source.read()
        const b = m ? maskBounds(m) : null
        const v = framingView(b)
        return {
          present: v.present,
          headCut: v.headCut,
          feetCut: v.feetCut,
          phase: r?.calib.phase ?? null,
          captured: r?.calib.captured ?? null,
        }
      },
      beginPlay: () => beginPlay(),
      setZoom: (z: number) => setZoom(z),
      setOffsetY: (o: number) => setOffsetY(o),
      resetTransform: () => resetTransform(),
      getTransform: () => ({ ...transformRef.current }),
      getBounds: () => {
        const m = rt.current?.source.read()
        return m ? maskBounds(m) : null
      },
      // Overwrite the game's calibration (headless play without the countdown).
      setCalibration: (cal: Calibration) => {
        calibrationRef.current = cal
        if (rt.current?.state) rt.current.state.calibration = cal
      },
      setFit: () => setSourceMask(fitMaskForWall()),
      setMiss: () => setSourceMask(missMaskForWall()),
      setNone: () => setSourceMask(null),
      autopilot: () => setSourceMask(fitMaskForWall()),
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
          calibrated: !!st?.calibration,
        }
      },
    }
    return () => {
      delete w.__silhouetteRush
    }
  }, [start, beginPlay, setZoom, setOffsetY, resetTransform, recalibrate])

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
    resetTransform,
    recalibrate,
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
