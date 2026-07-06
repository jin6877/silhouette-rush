// Pure, DOM-free game engine for 실루엣 러시.
// The whole simulation is driven by a per-frame player silhouette Mask (or
// null when the body is not detected), so it can be exercised headlessly with
// synthetic masks — no webcam, no ML model required.

import {
  POSES,
  buildWallMask,
  buildPoseMask,
  createMask,
  judge,
  type Mask,
  type Pose,
  type JudgeResult,
  type JudgeConfig,
} from './masks'

export type Phase = 'ready' | 'playing' | 'gameover'

export interface Wall {
  pose: Pose
  wallMask: Mask // 255 = solid
  holeMask: Mask // 255 = open hole (for rendering)
  progress: number // 0 (far) .. 1 (reaches the player / judgment plane)
  travelTime: number // seconds to travel from far to player
  judged: boolean
  judgeCfg: JudgeConfig // pass tolerance for this wall (tightens with round)
}

export type GameEvent =
  | { type: 'pass'; combo: number; gained: number; quality: number }
  | { type: 'fail'; heartsLeft: number }
  | { type: 'spawn'; poseName: string }
  | { type: 'gameover' }

export interface LiveFit {
  present: boolean
  collisionRatio: number
  fillRatio: number
  fitting: boolean // currently clean enough to pass
}

export interface GameConfig {
  hearts: number
  startTravel: number
  minTravel: number
  travelDecayPerRound: number
  gap: number // seconds between judgment and the next wall
  firstDelay: number // pre-roll before the first wall
}

export const defaultConfig = (): GameConfig => ({
  hearts: 3,
  // Start a touch slower than before (gentle entry with the new guide lines),
  // but ramp faster and to a lower floor so late rounds are genuinely tense.
  startTravel: 4.8,
  minTravel: 1.7,
  travelDecayPerRound: 0.2,
  gap: 0.9,
  firstDelay: 1.6,
})

/**
 * The pass tolerance tightens as rounds progress. The first couple of rounds
 * stay lenient (low entry barrier), then the collision tolerance shrinks and
 * the required hole-fill grows toward a demanding ceiling. Bounds are chosen so
 * a clean fit always passes while sloppy overlaps get punished harder late.
 */
export function judgeConfigForRound(round: number): JudgeConfig {
  const t = Math.min(1, Math.max(0, (round - 2) / 16))
  return {
    minArea: 0.04,
    maxCollision: 0.24 - t * 0.13, // 0.24 (lenient) → 0.11 (strict)
    minFill: 0.26 + t * 0.08, // 0.26 → 0.34
  }
}

export interface GameState {
  config: GameConfig
  phase: Phase
  wall: Wall | null
  betweenTimer: number
  round: number // walls spawned so far
  score: number
  combo: number
  bestCombo: number
  hearts: number
  maxHearts: number
  passes: number
  fails: number
  elapsed: number
  live: LiveFit
  lastResult: JudgeResult | null
  rngState: number
  recentPoses: string[] // ids of recently spawned poses (anti-repeat window)
  events: GameEvent[]
}

const EMPTY_MASK = createMask()

export function createGame(config: GameConfig = defaultConfig(), seed = 1): GameState {
  return {
    config,
    phase: 'ready',
    wall: null,
    betweenTimer: config.firstDelay,
    round: 0,
    score: 0,
    combo: 0,
    bestCombo: 0,
    hearts: config.hearts,
    maxHearts: config.hearts,
    passes: 0,
    fails: 0,
    elapsed: 0,
    live: { present: false, collisionRatio: 0, fillRatio: 0, fitting: false },
    lastResult: null,
    rngState: seed >>> 0,
    recentPoses: [],
    events: [],
  }
}

function rng(state: GameState): number {
  let a = state.rngState | 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  state.rngState = a
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * Choose the next pose. The difficulty band widens with the round (tier 1 only
 * at the start, up to tier 5 by ~round 8, and the very easiest tier is dropped
 * late game), and a shuffle-bag style window excludes the most recent poses so
 * the same shape never repeats back-to-back.
 */
export function pickPose(state: GameState): Pose {
  const round = state.round
  const maxDiff = Math.min(5, 1 + Math.floor(round / 2))
  const minDiff = round >= 12 ? 2 : 1
  let candidates = POSES.filter((p) => p.difficulty <= maxDiff && p.difficulty >= minDiff)
  if (candidates.length === 0) candidates = POSES
  const recent = state.recentPoses
  let pool = candidates.filter((p) => !recent.includes(p.id))
  if (pool.length === 0) pool = candidates
  const pose = pool[Math.floor(rng(state) * pool.length) % pool.length]
  // Remember it — keep the window smaller than the candidate pool so we never
  // starve the choice, and grow it (up to 6) as more poses unlock.
  const windowN = Math.max(1, Math.min(6, candidates.length - 1))
  state.recentPoses = [pose.id, ...recent.filter((id) => id !== pose.id)].slice(0, windowN)
  return pose
}

function travelForRound(cfg: GameConfig, round: number): number {
  return Math.max(cfg.minTravel, cfg.startTravel - round * cfg.travelDecayPerRound)
}

function spawnWall(state: GameState) {
  const pose = pickPose(state)
  const travelTime = travelForRound(state.config, state.round)
  state.wall = {
    pose,
    wallMask: buildWallMask(pose),
    holeMask: buildPoseMask(pose),
    progress: 0,
    travelTime,
    judged: false,
    judgeCfg: judgeConfigForRound(state.round),
  }
  state.round += 1
  state.events.push({ type: 'spawn', poseName: pose.name })
}

function pointsFor(state: GameState, quality: number): number {
  const comboMult = 1 + Math.min(state.combo, 12) * 0.12
  const base = 100 + Math.round(quality * 60)
  return Math.round(base * comboMult)
}

/**
 * Advance the simulation by `dt` seconds using the latest player silhouette.
 * Pass `null` when no body is detected. Returns the same (mutated) state.
 */
export function stepGame(state: GameState, player: Mask | null, dt: number): GameState {
  state.events = []
  if (state.phase === 'gameover') return state
  if (state.phase === 'ready') state.phase = 'playing'
  dt = Math.min(dt, 1 / 20)
  state.elapsed += dt

  const p = player ?? EMPTY_MASK

  if (state.wall) {
    const wall = state.wall
    wall.progress += dt / wall.travelTime

    // Live fit feedback every frame (drives silhouette color + meter).
    const live = judge(wall.wallMask, p, wall.judgeCfg)
    state.live = {
      present: live.present,
      collisionRatio: live.collisionRatio,
      fillRatio: live.fillRatio,
      fitting: live.pass,
    }

    if (wall.progress >= 1 && !wall.judged) {
      wall.judged = true
      const res = judge(wall.wallMask, p, wall.judgeCfg)
      state.lastResult = res
      if (res.pass) {
        state.combo += 1
        state.bestCombo = Math.max(state.bestCombo, state.combo)
        state.passes += 1
        const gained = pointsFor(state, res.quality)
        state.score += gained
        state.events.push({
          type: 'pass',
          combo: state.combo,
          gained,
          quality: res.quality,
        })
      } else {
        state.combo = 0
        state.fails += 1
        state.hearts -= 1
        state.events.push({ type: 'fail', heartsLeft: state.hearts })
        if (state.hearts <= 0) {
          state.phase = 'gameover'
          state.events.push({ type: 'gameover' })
        }
      }
      state.wall = null
      state.betweenTimer = state.config.gap
      state.live = { present: false, collisionRatio: 0, fillRatio: 0, fitting: false }
    }
  } else if (state.phase === 'playing') {
    state.betweenTimer -= dt
    if (state.betweenTimer <= 0) {
      spawnWall(state)
    }
  }

  return state
}

/** Seconds remaining until the current wall reaches the judgment plane. */
export function timeToImpact(state: GameState): number {
  if (!state.wall) return Math.max(0, state.betweenTimer)
  return Math.max(0, (1 - state.wall.progress) * state.wall.travelTime)
}

export function finalScore(state: GameState): number {
  return state.score
}
