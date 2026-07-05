import { PosePreview } from './PosePreview'

interface Props {
  best: number
  error: string | null
  onStart: () => void
  onDemo: () => void
}

const HERO_POSES = ['양팔 벌리기', '만세! 두 팔 위로', '한쪽 다리 옆차기', '웅크리기']

const STEPS = [
  {
    icon: '📷',
    title: '카메라 켜기',
    desc: '브라우저 권한을 허용하면 전신이 실루엣으로 변신',
  },
  {
    icon: '📏',
    title: '2m 뒤로',
    desc: '온몸이 화면에 담기게 카메라에서 두 걸음 물러서기',
  },
  {
    icon: '🕺',
    title: '구멍에 몸 맞추기',
    desc: '다가오는 벽의 구멍 모양대로 포즈를 잡아 통과!',
  },
]

export function StartScreen({ best, error, onStart, onDemo }: Props) {
  return (
    <div className="stage-lights relative flex min-h-[100svh] w-full flex-col items-center overflow-hidden px-5 pb-10 pt-8 sm:pt-12">
      <div className="grid-floor pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-40 [mask-image:linear-gradient(to_top,black,transparent)]" />
      {/* scan line */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-scan absolute inset-x-0 h-24 bg-gradient-to-b from-transparent via-[rgba(34,233,255,0.06)] to-transparent" />
      </div>

      <div className="relative z-10 flex w-full max-w-3xl flex-1 flex-col items-center">
        <div className="animate-fade-up mb-5 inline-flex items-center gap-2 rounded-full border border-[rgba(168,85,247,0.35)] bg-[rgba(44,19,82,0.5)] px-4 py-1.5 text-[13px] font-semibold tracking-wide text-mist-200 backdrop-blur">
          <span className="h-2 w-2 animate-pulse-glow rounded-full bg-neon-pink" />
          웹캠 전신 아케이드 · BRAIN WALL 챌린지
        </div>

        <p className="animate-fade-up neon-text-cyan text-center text-sm font-bold tracking-[0.5em] sm:text-base">
          SILHOUETTE&nbsp;RUSH
        </p>
        <h1 className="animate-fade-up text-neon-gradient mt-1 text-center text-6xl font-black leading-none tracking-tight sm:text-8xl">
          실루엣 러시
        </h1>
        <p className="animate-fade-up mt-4 max-w-md text-center text-base leading-relaxed text-mist-200 sm:text-lg">
          다가오는 벽의 구멍에 <span className="neon-text-pink font-bold">몸을 맞춰</span> 통과하는
          <br className="hidden sm:block" /> 웹캠 실루엣 챌린지
        </p>

        {/* Hero wall strip with pose holes */}
        <div className="animate-pop-in mt-8 flex w-full max-w-2xl items-stretch justify-center gap-2 sm:gap-3">
          {HERO_POSES.map((name, i) => (
            <div
              key={name}
              className="group relative flex-1 overflow-hidden rounded-2xl border border-[rgba(34,233,255,0.3)] bg-gradient-to-b from-[rgba(58,22,104,0.7)] to-[rgba(30,12,56,0.8)] p-2 shadow-[0_0_30px_-8px_rgba(168,85,247,0.6)]"
              style={{ animationDelay: `${i * 90}ms` }}
            >
              <div className="grid-floor absolute inset-0 opacity-30" />
              <div className="relative flex items-center justify-center rounded-xl bg-[rgba(10,5,20,0.55)] py-2">
                <PosePreview poseName={name} size={72} />
              </div>
            </div>
          ))}
        </div>

        {/* Steps */}
        <div className="animate-fade-up mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.title}
              className="glass-panel rounded-2xl p-4 text-left"
            >
              <div className="text-2xl">{s.icon}</div>
              <div className="mt-2 text-sm font-bold text-mist-50">{s.title}</div>
              <div className="mt-1 text-[13px] leading-snug text-mist-400">{s.desc}</div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="animate-fade-up mt-9 flex w-full max-w-md flex-col items-center gap-3">
          <button
            onClick={onStart}
            className="btn-neon w-full rounded-2xl px-8 py-4 text-lg font-black text-stage-950"
          >
            게임 시작 ▸ 카메라 켜기
          </button>
          <button
            onClick={onDemo}
            className="w-full rounded-2xl border border-[rgba(168,85,247,0.35)] bg-[rgba(30,12,56,0.5)] px-6 py-3 text-sm font-semibold text-mist-200 transition hover:border-[rgba(168,85,247,0.7)] hover:text-mist-50"
          >
            카메라 없이 데모 모드 보기
          </button>

          <div className="mt-1 flex items-center gap-3 text-[13px] text-mist-400">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(34,233,255,0.25)] bg-[rgba(34,233,255,0.06)] px-3 py-1">
              🔒 영상은 기기를 떠나지 않습니다
            </span>
            {best > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(255,46,154,0.3)] bg-[rgba(255,46,154,0.08)] px-3 py-1 font-semibold text-neon-pink-soft">
                🏆 최고 {best.toLocaleString()}
              </span>
            )}
          </div>

          {error && (
            <div className="mt-2 w-full rounded-xl border border-[rgba(255,46,154,0.45)] bg-[rgba(255,46,154,0.12)] px-4 py-3 text-center text-sm text-neon-pink-soft">
              {error}
            </div>
          )}
        </div>
      </div>

      <p className="relative z-10 mt-8 text-center text-xs text-mist-500">
        데스크톱 · 최신 크롬/엣지 권장 · WebGPU 지원 시 더 부드럽게 동작합니다
      </p>
    </div>
  )
}
