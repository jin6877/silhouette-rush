import type { Snapshot } from '../game/useSilhouetteRush'

interface Props {
  snap: Snapshot
  onStart: () => void
  onQuit: () => void
}

/**
 * The "자세 맞추기" step shown before a round starts. The canvas underneath draws
 * the live silhouette plus the head/feet guide lines (which sit exactly where
 * the pose holes expect them); this overlay adds the instruction, per-line
 * alignment status, the hold-to-start meter and the start/skip controls.
 */
export function FramingOverlay({ snap, onStart, onQuit }: Props) {
  const ready = snap.headAligned && snap.feetAligned

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex select-none flex-col justify-between">
      {/* Top: title + live instruction */}
      <div className="flex flex-col items-center gap-2 p-4 pt-5">
        <div className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-[rgba(168,85,247,0.4)] bg-[rgba(30,12,56,0.6)] px-4 py-1.5 text-xs font-bold tracking-wide text-mist-200 backdrop-blur">
          <span
            className={`h-2 w-2 rounded-full ${
              ready ? 'bg-neon-lime' : 'animate-pulse-glow bg-neon-cyan'
            }`}
          />
          자세 맞추기 · 카메라 프레이밍
        </div>
        <div
          className={`glass-panel max-w-md rounded-2xl px-5 py-3 text-center transition-colors duration-200 ${
            ready ? 'border-[rgba(182,255,58,0.6)] shadow-[0_0_30px_-6px_rgba(182,255,58,0.6)]' : ''
          }`}
        >
          <div className="text-sm font-black text-mist-50">
            {ready ? '✓ 준비 완료!' : '머리를 위 선 · 발을 아래 선에 맞추세요'}
          </div>
          <div className={`mt-1 text-xs font-semibold ${ready ? 'text-neon-lime' : 'text-mist-300'}`}>
            {snap.framingHint}
          </div>
        </div>
      </div>

      {/* Bottom: per-line status + actions */}
      <div className="flex flex-col items-center gap-3 p-4 pb-6">
        <div className="flex items-center gap-2">
          <StatusPill on={snap.headAligned} icon="👤" label="머리" />
          <StatusPill on={snap.feetAligned} icon="👣" label="발" />
        </div>

        {/* Hold-to-start meter (fills while fully aligned) */}
        <div
          className={`h-1.5 w-44 overflow-hidden rounded-full bg-[rgba(255,255,255,0.1)] transition-opacity ${
            ready ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div
            className="progress-neon h-full rounded-full transition-[width] duration-100"
            style={{ width: `${Math.round(snap.holdProgress * 100)}%` }}
          />
        </div>

        <div className="pointer-events-auto flex w-full max-w-md flex-col items-center gap-2.5">
          <button
            onClick={onStart}
            disabled={!ready}
            className={`btn-neon w-full rounded-2xl px-8 py-3.5 text-base font-black text-stage-950 transition ${
              ready ? '' : 'pointer-events-none opacity-40 grayscale'
            }`}
          >
            {ready ? '준비 완료 ▸ 시작' : '두 선에 맞추면 시작돼요'}
          </button>
          <div className="flex items-center gap-3 text-xs">
            <button
              onClick={onStart}
              className="rounded-full border border-[rgba(168,85,247,0.35)] bg-[rgba(30,12,56,0.5)] px-4 py-1.5 font-semibold text-mist-300 backdrop-blur transition hover:text-mist-50"
            >
              건너뛰고 바로 시작
            </button>
            <button
              onClick={onQuit}
              className="rounded-full px-3 py-1.5 font-semibold text-mist-500 transition hover:text-mist-200"
            >
              나가기
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ on, icon, label }: { on: boolean; icon: string; label: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-bold shadow-lg backdrop-blur transition-colors duration-200 ${
        on
          ? 'border-[rgba(182,255,58,0.75)] bg-[rgba(20,36,6,0.92)] text-neon-lime'
          : 'border-[rgba(34,233,255,0.5)] bg-[rgba(10,16,30,0.92)] text-neon-cyan-soft'
      }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
      <span className="tabular-nums">{on ? '✓ 맞음' : '조정'}</span>
    </div>
  )
}
