// Headless verification of the DOM-free game core using synthetic silhouette
// masks — no webcam, no ML model. Run with: npx tsx verify/verify.ts
import {
  POSES,
  buildWallMask,
  buildPoseMask,
  erodeMask,
  createMask,
  judge,
  maskArea,
  MASK_W,
  MASK_H,
  type Mask,
} from '../src/game/masks'
import { createGame, defaultConfig, stepGame, timeToImpact } from '../src/game/engine'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    console.error(`  ✗ ${msg}`)
    failures++
  }
}

// A solid rectangular player block (in grid fractions).
function blockMask(x0: number, y0: number, x1: number, y1: number): Mask {
  const m = createMask()
  for (let y = Math.floor(y0 * MASK_H); y < Math.floor(y1 * MASK_H); y++) {
    for (let x = Math.floor(x0 * MASK_W); x < Math.floor(x1 * MASK_W); x++) {
      m.data[y * MASK_W + x] = 255
    }
  }
  return m
}

// ---------------------------------------------------------------------------
console.log('1) 판정 함수: 구멍에 맞는 실루엣은 통과, 어긋난 실루엣은 충돌')
{
  for (const pose of POSES) {
    const wall = buildWallMask(pose)
    const hole = buildPoseMask(pose)
    const good = erodeMask(hole, 2) // 사람이 구멍 안에 들어간 상태
    const r = judge(wall, good)
    assert(
      r.pass && r.collisionRatio < 0.1,
      `[${pose.name}] 구멍에 맞춘 실루엣 통과 (충돌 ${(r.collisionRatio * 100).toFixed(0)}%, 채움 ${(r.fillRatio * 100).toFixed(0)}%)`,
    )
  }
  // 벽의 채워진 부분을 덮는 실루엣 → 충돌
  const pose = POSES[0]
  const wall = buildWallMask(pose)
  const bad = blockMask(0.02, 0.05, 0.28, 0.95) // 왼쪽 기둥(대부분 벽)
  const r = judge(wall, bad)
  assert(!r.pass && r.collisionRatio > 0.4, `벽면을 덮은 실루엣 충돌 (충돌 ${(r.collisionRatio * 100).toFixed(0)}%)`)

  // 프레임에 사람이 거의 없으면 미검출 → 실패
  const empty = createMask()
  const re = judge(wall, empty)
  assert(!re.pass && !re.present, '빈 프레임(사람 없음)은 미검출로 실패')
}

// ---------------------------------------------------------------------------
console.log('2) 완벽한 플레이어(매 벽 구멍에 정확히 맞춤) → 연속 통과 & 콤보/점수 상승')
{
  const state = createGame(defaultConfig(), 123)
  const dt = 1 / 60
  let frames = 0
  while (state.phase !== 'gameover' && frames < 60 * 90) {
    // 현재 벽이 있으면 그 구멍에 딱 맞는 몸을 만든다.
    const player = state.wall ? erodeMask(state.wall.holeMask, 2) : null
    stepGame(state, player, dt)
    frames++
    if (state.passes >= 20) break
  }
  assert(state.passes >= 20, `완벽 플레이로 20회 이상 통과 (통과 ${state.passes}, 실패 ${state.fails})`)
  assert(state.fails === 0, `완벽 플레이 중 실패 없음 (실패 ${state.fails})`)
  assert(state.hearts === state.maxHearts, `하트 유지 (${state.hearts}/${state.maxHearts})`)
  assert(state.bestCombo >= 20, `콤보 누적 (최고 콤보 ${state.bestCombo})`)
  assert(state.score > 2000, `점수 상승 (${state.score}점)`)
}

// ---------------------------------------------------------------------------
console.log('3) 항상 어긋난 실루엣 → 하트 소진 후 게임오버')
{
  const state = createGame(defaultConfig(), 55)
  const dt = 1 / 60
  let frames = 0
  while (state.phase !== 'gameover' && frames < 60 * 120) {
    // 벽 위치와 무관하게 왼쪽 기둥을 덮는다 → 매번 충돌
    stepGame(state, blockMask(0.0, 0.05, 0.3, 0.98), dt)
    frames++
  }
  assert(state.phase === 'gameover', '지속 충돌 시 게임오버 도달')
  assert(state.fails === state.maxHearts, `하트 수만큼 실패 후 종료 (실패 ${state.fails}, 하트 ${state.maxHearts})`)
  assert(state.passes === 0, '한 번도 통과 못함')
}

// ---------------------------------------------------------------------------
console.log('4) 몸을 안 움직임(빈 프레임 유지) → 게임오버')
{
  const state = createGame(defaultConfig(), 7)
  const dt = 1 / 60
  let frames = 0
  while (state.phase !== 'gameover' && frames < 60 * 120) {
    stepGame(state, null, dt)
    frames++
  }
  assert(state.phase === 'gameover', '사람이 안 보이면 통과 실패로 게임오버')
}

// ---------------------------------------------------------------------------
console.log('5) 난이도 곡선: 라운드가 진행될수록 벽이 빨리 온다')
{
  const state = createGame(defaultConfig(), 9)
  const dt = 1 / 60
  const travels: number[] = []
  let frames = 0
  while (travels.length < 8 && frames < 60 * 120) {
    const hadWall = !!state.wall
    const player = state.wall ? erodeMask(state.wall.holeMask, 2) : null
    stepGame(state, player, dt)
    if (!hadWall && state.wall) travels.push(state.wall.travelTime)
    frames++
    if (state.phase === 'gameover') break
  }
  const decreasing = travels.every((t, i) => i === 0 || t <= travels[i - 1] + 1e-6)
  assert(decreasing, `이동 시간 비증가: ${travels.map((t) => t.toFixed(2)).join(' → ')}`)
  assert(travels[travels.length - 1] < travels[0], `첫 벽보다 마지막 벽이 빠름 (${travels[0].toFixed(2)}s → ${travels[travels.length - 1].toFixed(2)}s)`)
}

// ---------------------------------------------------------------------------
console.log('6) timeToImpact / 카운트다운 값이 단조 감소')
{
  const state = createGame(defaultConfig(), 3)
  const dt = 1 / 60
  // 첫 벽이 생길 때까지 진행
  let frames = 0
  while (!state.wall && frames < 600) {
    stepGame(state, null, dt)
    frames++
  }
  let prev = timeToImpact(state)
  let mono = true
  for (let i = 0; i < 30; i++) {
    stepGame(state, state.wall ? erodeMask(state.wall.holeMask, 2) : null, dt)
    const t = timeToImpact(state)
    if (state.wall && t > prev + 1e-6) mono = false
    prev = t
  }
  assert(mono, '벽 접근 중 남은 시간이 감소')
}

// ---------------------------------------------------------------------------
console.log('7) 마스크 형상 sanity: 포즈 실루엣은 화면의 일부만 차지')
{
  for (const pose of POSES) {
    const a = maskArea(buildPoseMask(pose))
    assert(a > 0.04 && a < 0.6, `[${pose.name}] 실루엣 면적 ${(a * 100).toFixed(0)}% (합리적 범위)`)
  }
}

console.log('')
if (failures === 0) {
  console.log('✅ 모든 검증 통과')
  process.exit(0)
} else {
  console.error(`❌ ${failures}개 검증 실패`)
  process.exit(1)
}
