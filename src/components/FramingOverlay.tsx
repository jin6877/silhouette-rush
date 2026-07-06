import type { CaptureTransform } from '../game/maskSource'
import {
  ZOOM_MIN,
  ZOOM_MAX,
  OFFSET_MIN,
  OFFSET_MAX,
  type Snapshot,
} from '../game/useSilhouetteRush'

interface Props {
  snap: Snapshot
  transform: CaptureTransform
  onZoom: (zoom: number) => void
  onOffsetY: (offsetY: number) => void
  onRecalibrate: () => void
  onReset: () => void
  onStart: () => void
  onQuit: () => void
}

/**
 * The "자세 맞추기" step, rendered as a panel BESIDE the camera view on desktop and
 * BELOW it on narrow screens — never over the silhouette. The camera view itself
 * shows only the live body + guide lines snapped to the detected head/feet. Here
 * we run the hold-still countdown that captures the standing body (the judgment
 * reference), surface cut-off warnings, expose the secondary zoom/offset aids,
 * and gate the round behind an explicit [시작] click.
 */
export function FramingPanel({
  snap,
  transform,
  onZoom,
  onOffsetY,
  onRecalibrate,
  onReset,
  onStart,
  onQuit,
}: Props) {
  const ready = snap.framingReady
  const cut = snap.present && (snap.headCut || snap.feetCut)
  const counting = snap.calibPhase === 'counting' && snap.present && !cut

  const statusTone = ready
    ? 'border-[rgba(182,255,58,0.7)] shadow-[0_0_30px_-8px_rgba(182,255,58,0.7)]'
    : cut
      ? 'border-[rgba(255,86,140,0.7)] shadow-[0_0_30px_-8px_rgba(255,86,140,0.6)]'
      : 'border-[rgba(34,233,255,0.5)]'

  return (
    <aside className="pointer-events-auto flex w-full shrink-0 select-none flex-col gap-3 overflow-y-auto border-t border-[rgba(168,85,247,0.25)] bg-[rgba(12,5,24,0.72)] p-4 backdrop-blur md:h-full md:w-[22rem] md:border-l md:border-t-0 lg:w-[24rem]">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(168,85,247,0.4)] bg-[rgba(30,12,56,0.6)] px-3.5 py-1.5 text-xs font-bold tracking-wide text-mist-200">
          <span
            className={`h-2 w-2 rounded-full ${
              ready ? 'bg-neon-lime' : cut ? 'bg-neon-pink' : 'animate-pulse-glow bg-neon-cyan'
            }`}
          />
          자세 맞추기
        </div>
        <button
          onClick={onQuit}
          className="rounded-full px-3 py-1.5 text-xs font-semibold text-mist-500 transition hover:text-mist-200"
        >
          나가기
        </button>
      </div>

      {/* Countdown / status */}
      <div className={`glass-panel flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${statusTone}`}>
        <div
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-3xl font-black tabular-nums ${
            ready
              ? 'bg-[rgba(20,36,6,0.9)] text-neon-lime'
              : cut
                ? 'bg-[rgba(46,10,24,0.9)] text-neon-pink'
                : 'bg-[rgba(10,16,30,0.9)] text-neon-cyan-soft'
          }`}
        >
          {ready ? '✓' : counting ? snap.calibCount || '·' : cut ? '!' : '···'}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-black text-mist-50">
            {ready
              ? '기준 완료'
              : counting
                ? '가만히 서 있어요'
                : cut
                  ? '몸이 화면 밖으로 잘렸어요'
                  : '온몸이 보이게 서주세요'}
          </div>
          <div
            className={`mt-0.5 text-xs font-semibold ${
              ready ? 'text-neon-lime' : cut ? 'text-neon-pink-soft' : 'text-mist-300'
            }`}
          >
            {snap.framingHint}
          </div>
        </div>
      </div>

      {/* Per-edge cut status */}
      <div className="flex items-center gap-2">
        <EdgePill cut={snap.present && snap.headCut} icon="👤" label="머리" />
        <EdgePill cut={snap.present && snap.feetCut} icon="👣" label="발" />
      </div>

      <button
        onClick={onRecalibrate}
        className="w-full rounded-xl border border-[rgba(34,233,255,0.4)] bg-[rgba(10,22,34,0.6)] px-3 py-2.5 text-sm font-black text-neon-cyan-soft transition hover:brightness-125"
      >
        {ready ? '↻ 다시 맞추기' : '↻ 카운트다운 다시'}
      </button>

      {/* Secondary framing aids (zoom can't widen the camera FOV — move/tilt the
          camera to fix cut-offs; these just fine-tune). */}
      <div className="glass-panel flex flex-col gap-2.5 rounded-2xl px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold tracking-widest text-mist-400">보조 조절</span>
          <span className="text-[10px] font-semibold text-mist-500">줌은 화각을 못 넓혀요</span>
        </div>
        <SliderRow
          icon="🔍"
          label="줌"
          value={transform.zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={0.01}
          display={`${Math.round(transform.zoom * 100)}%`}
          onChange={onZoom}
        />
        <SliderRow
          icon="↕"
          label="상하"
          value={transform.offsetY}
          min={OFFSET_MIN}
          max={OFFSET_MAX}
          step={0.005}
          display={`${transform.offsetY > 0 ? '+' : ''}${Math.round(transform.offsetY * 100)}`}
          onChange={onOffsetY}
        />
        <button
          onClick={onReset}
          className="self-end rounded-lg border border-[rgba(168,85,247,0.35)] bg-[rgba(30,12,56,0.5)] px-3 py-1.5 text-xs font-semibold text-mist-300 transition hover:text-mist-50"
        >
          초기화
        </button>
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-1">
        <button
          onClick={onStart}
          disabled={!ready}
          className={`btn-neon w-full rounded-2xl px-8 py-3.5 text-base font-black text-stage-950 transition ${
            ready ? '' : 'pointer-events-none opacity-40 grayscale'
          }`}
        >
          {ready ? '시작 ▸' : '기준을 잡으면 시작할 수 있어요'}
        </button>
        <button
          onClick={onStart}
          className="self-center rounded-full border border-[rgba(168,85,247,0.35)] bg-[rgba(30,12,56,0.5)] px-4 py-1.5 text-xs font-semibold text-mist-300 transition hover:text-mist-50"
        >
          건너뛰고 바로 시작
        </button>
      </div>
    </aside>
  )
}

function SliderRow({
  icon,
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  icon: string
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (v: number) => void
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-xs font-bold text-mist-200">
        {icon} {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="zoom-slider h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[rgba(255,255,255,0.12)]"
      />
      <span className="w-11 shrink-0 text-right text-xs font-bold tabular-nums text-neon-cyan-soft">
        {display}
      </span>
    </label>
  )
}

function EdgePill({ cut, icon, label }: { cut: boolean; icon: string; label: string }) {
  return (
    <div
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-bold transition-colors ${
        cut
          ? 'border-[rgba(255,86,140,0.75)] bg-[rgba(46,10,24,0.85)] text-neon-pink-soft'
          : 'border-[rgba(182,255,58,0.6)] bg-[rgba(20,36,6,0.7)] text-neon-lime'
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
      <span className="tabular-nums">{cut ? '잘림' : '✓'}</span>
    </div>
  )
}
