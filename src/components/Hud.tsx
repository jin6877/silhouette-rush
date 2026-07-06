import type { Snapshot } from '../game/useSilhouetteRush'
import { ZOOM_MIN, ZOOM_MAX } from '../game/useSilhouetteRush'
import type { CaptureTransform } from '../game/maskSource'
import { PosePreview } from './PosePreview'

interface Props {
  snap: Snapshot
  transform: CaptureTransform
  onZoom: (zoom: number) => void
  onQuit: () => void
}

export function Hud({ snap, transform, onZoom, onQuit }: Props) {
  const hasWall = snap.poseName != null
  const countdown = hasWall ? Math.max(1, Math.ceil(snap.timeToImpact)) : null
  const showBigCount = hasWall && snap.timeToImpact <= 3 && snap.progress < 0.98

  const fitState = !hasWall
    ? 'idle'
    : snap.fitting
      ? 'good'
      : snap.present && snap.collisionRatio > 0.28
        ? 'bad'
        : 'aim'

  return (
    <div className="pointer-events-none absolute inset-0 z-10 select-none">
      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between p-4 sm:p-5">
        <div className="animate-fade-up">
          <div className="text-[11px] font-bold tracking-widest text-mist-400">SCORE</div>
          <div className="text-neon-gradient text-4xl font-black leading-none tabular-nums sm:text-5xl">
            {snap.score.toLocaleString()}
          </div>
          {snap.combo > 1 && (
            <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-[rgba(182,255,58,0.15)] px-2.5 py-0.5 text-sm font-black text-neon-lime">
              🔥 {snap.combo} COMBO
            </div>
          )}
        </div>

        <div className="flex flex-col items-end gap-2">
          {/* Hearts */}
          <div className="flex gap-1.5">
            {Array.from({ length: snap.maxHearts }).map((_, i) => (
              <span
                key={i}
                className={`text-2xl transition-all duration-300 ${
                  i < snap.hearts
                    ? 'scale-100 drop-shadow-[0_0_8px_rgba(255,46,154,0.8)]'
                    : 'scale-90 opacity-25 grayscale'
                }`}
              >
                {i < snap.hearts ? '💗' : '🖤'}
              </span>
            ))}
          </div>
          <div className="rounded-full border border-[rgba(168,85,247,0.35)] bg-[rgba(30,12,56,0.6)] px-3 py-1 text-xs font-bold text-mist-200 backdrop-blur">
            라운드 {snap.round}
          </div>
          {/* Quick in-game zoom (carried over from framing, live-adjustable) */}
          <label className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-[rgba(168,85,247,0.3)] bg-[rgba(30,12,56,0.55)] px-2.5 py-1 backdrop-blur">
            <span className="text-[11px] font-bold text-mist-300">🔍</span>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={0.01}
              value={transform.zoom}
              onChange={(e) => onZoom(Number(e.target.value))}
              className="zoom-slider h-1 w-20 cursor-pointer appearance-none rounded-full bg-[rgba(255,255,255,0.14)]"
            />
            <span className="w-8 text-right text-[11px] font-bold tabular-nums text-neon-cyan-soft">
              {Math.round(transform.zoom * 100)}%
            </span>
          </label>
          <button
            onClick={onQuit}
            className="pointer-events-auto rounded-full border border-[rgba(168,85,247,0.3)] bg-[rgba(30,12,56,0.5)] px-3 py-1 text-xs font-semibold text-mist-400 backdrop-blur transition hover:text-mist-50"
          >
            나가기
          </button>
        </div>
      </div>

      {/* Big countdown */}
      {showBigCount && countdown != null && (
        <div className="pointer-events-none absolute inset-x-0 top-[16%] flex justify-center">
          <div
            key={countdown}
            className="animate-pop-in text-8xl font-black text-neon-pink-soft drop-shadow-[0_0_24px_rgba(255,46,154,0.7)] sm:text-9xl"
          >
            {countdown}
          </div>
        </div>
      )}

      {/* Bottom: pose target + fit meter */}
      {hasWall && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 p-4 pb-5 sm:pb-6">
          <div
            className={`glass-panel flex items-center gap-3 rounded-2xl px-4 py-2.5 transition-colors duration-200 ${
              fitState === 'good'
                ? 'border-[rgba(182,255,58,0.6)] shadow-[0_0_30px_-6px_rgba(182,255,58,0.7)]'
                : fitState === 'bad'
                  ? 'border-[rgba(255,46,154,0.6)]'
                  : ''
            }`}
          >
            <div className="rounded-xl bg-[rgba(10,5,20,0.5)] p-1">
              <PosePreview poseName={snap.poseName} size={54} />
            </div>
            <div>
              <div className="text-[11px] font-bold tracking-widest text-mist-400">이 포즈로 통과</div>
              <div className="text-base font-black text-mist-50">{snap.poseName}</div>
              <div
                className={`text-xs font-bold ${
                  fitState === 'good'
                    ? 'text-neon-lime'
                    : fitState === 'bad'
                      ? 'text-neon-pink'
                      : 'text-mist-400'
                }`}
              >
                {fitState === 'good'
                  ? '✓ 딱 맞았어요! 그대로 유지'
                  : fitState === 'bad'
                    ? '✕ 벽에 부딪혀요! 몸을 옮기세요'
                    : !snap.present
                      ? '카메라에 전신을 담아주세요'
                      : '구멍 모양에 몸을 맞추세요'}
              </div>
            </div>
          </div>

          {/* Approach gauge */}
          <div className="h-2 w-full max-w-md overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
            <div
              className="progress-neon h-full rounded-full transition-[width] duration-75"
              style={{ width: `${Math.min(100, snap.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Privacy + fps */}
      <div className="absolute bottom-1.5 right-3 flex items-center gap-2 text-[10px] text-mist-500">
        {snap.fps > 0 && <span>{snap.fps} fps</span>}
        <span>🔒 로컬 처리</span>
      </div>
    </div>
  )
}
