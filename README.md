# 실루엣 러시 (Silhouette Rush)

![실루엣 러시](public/thumbnail.png)

> **몸으로 통과하는 벽.** 웹캠 앞에서 포즈를 잡아 다가오는 벽의 구멍 모양에 몸을 맞춰 통과하는 전신 아케이드 게임. 일본/한국 예능 *브레인월(Hole in the Wall)* 컨셉의 브라우저판.

<p>
  <img alt="React" src="https://img.shields.io/badge/React-19-22e9ff?logo=react&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-a855f7?logo=vite&logoColor=white" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind-v4-ff2e9a?logo=tailwindcss&logoColor=white" />
  <img alt="transformers.js" src="https://img.shields.io/badge/transformers.js-MODNet-b6ff3a?logo=huggingface&logoColor=black" />
</p>

## 🔗 라이브 데모

**▶ [silhouette-rush.vercel.app](https://silhouette-rush.vercel.app)**

> 데스크톱 + 웹캠 환경을 권장합니다. 카메라가 없어도 **데모 모드**로 게임 플레이를 볼 수 있어요.

---

## 🎮 게임 방법

1. **카메라 켜기** — 브라우저 카메라 권한을 허용하면 전신이 네온 실루엣으로 변신합니다.
2. **2m 뒤로** — 온몸이 화면에 담기게 카메라에서 두 걸음 물러서세요. (좌우 반전 거울 모드)
3. **구멍에 몸 맞추기** — 무대 안쪽에서 **구멍 뚫린 벽이 다가옵니다.** 벽이 도달하는 순간, 구멍(빈 공간) 모양에 몸을 맞추고 있으면 **통과**, 벽의 채워진 부분에 부딪히면 **충돌**!

라운드가 진행될수록 벽이 더 빨리 오고 포즈가 어려워집니다. 하트 3개를 모두 잃으면 게임 오버.

## ✨ 주요 기능

- 🧍 **실시간 인체 세그멘테이션** — [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)의 **MODNet** 매팅 모델로 매 프레임 실루엣 마스크를 추출. WebGPU 우선, 미지원 시 WASM 폴백.
- 🎯 **픽셀 겹침 판정** — 벽의 채워진 픽셀과 플레이어 실루엣의 **겹침 비율**로 통과/충돌을 판정. 사람은 완벽히 못 맞추니 임계치는 관대하게.
- 🕺 **8종 포즈 구멍** — 차렷·양팔 벌리기·만세·한 팔 번쩍·옆으로 기울이기·점프 스타·한쪽 다리 옆차기·웅크리기. 깔끔한 실루엣 도형으로 재현 가능한 난이도.
- 💯 **점수 · 콤보 · 하트** — 통과할 때마다 콤보 배수가 붙고, 라운드가 오를수록 난이도 상승.
- 🎇 **네온 게임쇼 연출** — 원근감 있게 밀려오는 벽, 실루엣 글로우(맞으면 라임 그린, 부딪히면 핫핑크), 통과 파티클·충돌 흔들림.
- ⏱️ **3·2·1 카운트다운** — 벽이 다가오는 게이지 + 카운트다운으로 포즈 잡을 여유를 제공.
- 📸 **결과 스코어 카드** — 최종 점수와 마지막 실루엣 스냅샷을 캔버스로 합성해 **이미지 저장 / 클립보드 복사**. 실패 짤 공유용.
- 🔒 **완전 프론트엔드** — 카메라 영상은 서버로 전송되지 않고 **기기 안에서만** 처리됩니다. 서버·API 키 없음.

## 🧠 어떻게 동작하나

```
웹캠 프레임 ──(좌우반전, 256×192로 축소)──▶ MODNet 매팅 ──▶ 알파 마스크
      │                                                        │
      ▼                                                        ▼
  네온 실루엣 렌더링                              128×96 게임 그리드로 다운샘플
                                                               │
   벽 마스크(포즈 구멍) ──────── 겹침 픽셀 판정 ──────────────┘
                                     │
                        통과 / 충돌 · 점수 · 콤보 · 하트
```

- **입력 소스를 인터페이스로 분리**했습니다. 게임 로직은 `MaskSource`(실제 웹캠) 또는 `FakeMaskSource`(주입형) 어느 쪽으로도 구동됩니다.
- **판정·점수·라운드·게임오버 로직은 DOM/모델 없는 순수 모듈**(`src/game/masks.ts`, `src/game/engine.ts`)이라, 합성 마스크로 자동 검증이 가능합니다.

```bash
npx tsx verify/verify.ts   # 구멍에 맞는 마스크=통과, 어긋난 마스크=충돌 등 자동 검증
```

## 🛠️ 기술 스택

- **React 19** + **TypeScript** + **Vite 8**
- **Tailwind CSS v4** (`@tailwindcss/vite`)
- **@huggingface/transformers** (MODNet 실시간 매팅, WebGPU/WASM)
- Canvas 2D 렌더링 · Web `getUserMedia` · `localStorage`(최고 점수)

## 💻 로컬 실행

```bash
npm install
npm run dev
```

빌드 & 검증:

```bash
npm run build            # 타입체크 + 프로덕션 빌드
npx tsx verify/verify.ts # 게임 코어 로직 자동 검증
```

## 📁 프로젝트 구조

```
src/
├─ game/
│  ├─ masks.ts             # 마스크 유틸 + 포즈 구멍 라이브러리 + 겹침 판정(순수)
│  ├─ engine.ts            # 게임 상태 머신: 벽 접근·판정·점수·콤보·하트(순수)
│  ├─ segmentation.ts      # MODNet 로딩/추론 (WebGPU→WASM, 진행률 이벤트)
│  ├─ maskSource.ts        # MaskSource 인터페이스 · WebcamMaskSource · FakeMaskSource
│  ├─ render.ts            # 네온 무대·원근 벽·실루엣·파티클 캔버스 렌더러
│  ├─ scoreCard.ts         # 공유용 결과 카드 캔버스 생성
│  └─ useSilhouetteRush.ts # 게임 루프 훅(소스 주입 + 테스트 훅)
├─ components/             # StartScreen · Hud · GameOverScreen · LoadingOverlay · PosePreview
└─ App.tsx
verify/verify.ts           # 합성 마스크 기반 헤드리스 검증
```

## 📷 스크린샷

![앱 스크린샷](docs/screenshot.png)

---

<sub>영상은 기기를 떠나지 않습니다. · Made with React + transformers.js</sub>
