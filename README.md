# 그램값 — GitHub + Vercel 배포판

가격표 사진 2~4장을 찍으면 AI(Claude)가 상품명·가격·용량·행사문구를 읽고,
프론트엔드에서 100ml/100g/개당 실단가를 계산해 순위를 매겨주는 앱입니다.

Supabase 없이 **GitHub 저장소 하나 + Vercel 프로젝트 하나**로 끝나도록 구성했습니다.
프론트엔드(Vite 정적 사이트)와 백엔드(Vercel 서버리스 함수)가 같은 저장소, 같은 배포에 들어있습니다.

## 구조와 보안 모델

```
브라우저(프론트엔드, 정적 파일)
  │  이미지(base64) 전송  (같은 도메인이므로 CORS 설정 불필요)
  ▼
/api/analyze-price.js   ← Vercel 서버리스 함수. ANTHROPIC_API_KEY는 여기(서버)에만 존재
  │  Anthropic Vision API 호출
  ▼
Claude가 상품명/가격/용량/단위/구성개수/행사문구만 JSON으로 반환
  │
  ▼
브라우저에서 단위 환산 · 행사가 계산 · 100ml/100g당 가격 계산 · 정렬
```

- `ANTHROPIC_API_KEY`는 브라우저 코드, 번들, 응답 본문 어디에도 포함되지 않습니다.
  Vercel 프로젝트의 서버 환경변수로만 존재하고, `/api/analyze-price.js` 안에서만 사용됩니다.
- 프론트엔드가 알아야 하는 값은 **없습니다.** (`VITE_...` 환경변수 자체가 필요 없음)
- 이력(비교 결과)은 서버로 전송하지 않고 각 사용자 브라우저의 `localStorage`에만 저장됩니다.

## 배포 방법 (3단계)

### 1) GitHub에 올리기
```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/YOUR_ID/geuramgap.git
git push -u origin main
```

### 2) Vercel에서 이 저장소 Import
- vercel.com 로그인 → "Add New… → Project" → 방금 만든 GitHub 저장소 선택
- Framework Preset: **Vite** (자동 감지됨) — Build/Output 설정 그대로 두면 됩니다.
- `api/` 폴더는 Vercel이 자동으로 서버리스 함수로 인식하므로 별도 설정이 필요 없습니다.

### 3) 환경변수 설정
Vercel 프로젝트 → Settings → Environment Variables 에서 추가:
| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` (Anthropic 콘솔에서 발급) |
| `ANTHROPIC_MODEL` (선택) | `claude-sonnet-5` (기본값이라 생략 가능) |

저장 후 "Redeploy" 한 번 눌러주면 끝입니다. 이후로는 `git push`만 하면 자동 배포됩니다.

## 로컬에서 확인하기

Vercel CLI로 돌리면 `/api` 함수까지 로컬에서 그대로 테스트할 수 있습니다 (`vite dev`만 돌리면 `/api`가 안 뜹니다).
```bash
npm install -g vercel
npm install
vercel dev
```
`.env.local`에 `ANTHROPIC_API_KEY=sk-ant-...` 를 넣어두면 로컬에서도 인식됩니다 (git에는 커밋되지 않음).

## 다른 사용자의 휴대폰에서도 동작하는 이유

- 프론트엔드는 정적 파일이라 어떤 기기의 브라우저에서 열어도 동일하게 동작합니다.
- AI 인식 호출은 항상 "브라우저 → `/api/analyze-price` → Anthropic API" 경로를 타고,
  실제 비밀키는 Vercel 서버에만 있기 때문에 접속하는 모든 사용자가 동일하게 정상 인식됩니다.
  (기존 아티팩트 프로토타입처럼 특정 대화창/세션에 묶이지 않습니다.)
- `capture="environment"` 속성으로 모바일에서 후면 카메라 촬영을 바로 열 수 있고,
  "갤러리에서 가져오기" 버튼으로 기존 사진 선택도 가능합니다.

## 운영 시 참고 사항 (선택)

- **함수 실행 시간**: Vercel Hobby 플랜은 서버리스 함수 기본 제한이 10초입니다. 사진이 많거나 응답이
  느리면 시간 초과가 날 수 있으니, 필요하면 `vercel.json`에 `functions.maxDuration`을 늘리거나(Pro 플랜 필요)
  이미지 장수를 줄이는 것을 고려하세요.
- **남용 방지**: 현재는 요청당 이미지 4장, base64 크기 상한만 검사합니다. 트래픽이 늘어나면
  Vercel의 Rate Limiting(Firewall) 기능이나 Cloudflare Turnstile 같은 봇 방지 수단 추가를 권장합니다.
- **비용**: Vision 호출 1회(사진 2~4장)당 Claude API 비용이 발생합니다. 트래픽이 많다면
  `ANTHROPIC_MODEL`을 더 저렴한 모델로 바꾸는 것을 고려하세요.

## 파일 구성

```
index.html          Vite 진입점(HTML), 기존 UI 마크업 그대로 유지
src/style.css        기존 프로토타입 스타일 (모바일에서는 폰 목업 테두리 자동 제거)
src/main.js          촬영/비교/결과/이력 UI 로직 + /api/analyze-price 호출
api/analyze-price.js  Claude Vision API를 호출하는 서버리스 함수 (API 키는 여기서만 사용)
.env.example         참고용 안내 (프론트엔드 비밀키 없음)
```
