# Garden Lens 모듈 계약 (Module Contract)

이 문서는 서버, 클라이언트 모듈, 테스트가 공유하는 인터페이스의 단일 기준입니다.
구현 에이전트는 이 계약을 바꾸지 않고 각자의 파일만 수정합니다. 계약을 바꿔야 하면 이유를 결과에 명시합니다.

## 1. 아키텍처

- 모바일 우선 PWA. 브라우저에서 `getUserMedia`로 후면 카메라를 열고, 프레임을 캡처해 서버로 보냅니다.
- Node 22 + Express 5 서버가 정적 파일을 서빙하고 `POST /api/identify`에서 비전 모델을 호출합니다. API 키는 서버에만 있습니다.
- 클라이언트는 ES 모듈(`<script type="module">`). 순수 함수 모듈(`overlay-math.js`, `quality.js`)은 Node `node:test`에서도 import 가능해야 합니다 (DOM, window 참조 금지).

## 2. HTTP API

### `POST /api/identify`

요청 (JSON, 최대 6 MB):

```json
{
  "image": "<base64 JPEG, data: 접두어 없음>",
  "width": 1024,
  "height": 768,
  "lang": "ko"
}
```

- `image`: JPEG를 base64로 인코딩한 문자열. `data:image/jpeg;base64,` 접두어가 오면 서버가 제거합니다.
- `width`, `height`: 보낸 이미지의 픽셀 크기 (정수). bbox 정규화의 기준이 됩니다.
- `lang`: 현재 `"ko"`만 지원. 생략 시 `"ko"`.

응답 200 (JSON):

```json
{
  "quality": "ok",
  "message_ko": null,
  "plants": [
    {
      "id": "p1",
      "name_ko": "동백나무",
      "name_sci": "Camellia japonica",
      "name_en": "Japanese camellia",
      "family_ko": "차나무과",
      "confidence": 0.86,
      "bbox": { "x": 0.12, "y": 0.20, "w": 0.35, "h": 0.50 },
      "summary_ko": "겨울에서 이른 봄에 붉은 꽃이 피는 상록 활엽수입니다.",
      "detail_ko": "특징, 개화기, 분포, 쓰임새, 관찰 포인트 등을 담은 3문단 이내의 설명",
      "tags": ["상록수", "겨울꽃"]
    }
  ],
  "model": "claude-opus-5",
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

필드 규칙:

- `quality`: `"ok" | "too_dark" | "too_far" | "blurry" | "no_plant"`.
  - `ok`가 아니면 `plants`는 빈 배열이고 `message_ko`에 사용자 안내 문구가 옵니다.
  - `too_dark`: 플래시를 켜거나 더 밝은 곳으로 안내. `too_far`: 더 가까이 가라고 안내. `blurry`: 카메라를 고정하라고 안내. `no_plant`: 화면에 식물이 없음.
- `plants[].bbox`: 보낸 이미지 기준 정규화 좌표 (0..1). `x, y`는 좌상단, `w, h`는 폭과 높이. 서버는 값을 0..1로 클램프합니다.
- `plants[].confidence`: 0..1. 서버는 0.35 미만인 항목을 제거합니다. 모든 항목이 제거되면 `quality`를 `"too_far"`로 바꾸고 `message_ko`를 채웁니다.
- `plants[].id`: 응답 내 고유 문자열 (`p1`, `p2`, ...).
- `plants`는 `confidence` 내림차순, 최대 6개.
- `usage`는 제공자가 주지 않으면 0으로 채웁니다.

오류 응답 (JSON):

```json
{ "error": { "code": "bad_request", "message_ko": "이미지가 비어 있습니다." } }
```

- 400 `bad_request`: 필드 누락, base64 아님, 너무 큼.
- 401 `no_api_key`: 서버에 `ANTHROPIC_API_KEY`가 없음.
- 429 `rate_limited`: 서버 또는 상위 API의 요청 제한.
- 502 `upstream_error`: 모델 호출 실패 또는 응답 파싱 실패.
- 503 `refused`: 모델이 요청을 거절함 (`stop_reason: "refusal"`).

### `GET /api/health`

`{ "ok": true, "provider": "claude" | "mock", "model": "..." }`

## 3. 서버 제공자 인터페이스 (`providers/*.js`)

```js
// export default async function identify({ imageBase64, mediaType, width, height, lang }) -> IdentifyResponse
// 위 응답 스키마 그대로 (quality, message_ko, plants, model, usage). 검증과 클램프는 server.js가 한 번 더 수행합니다.
```

- `providers/claude.js`: Anthropic SDK. 모델은 `process.env.CLAUDE_MODEL || "claude-opus-5"`.
- `providers/mock.js`: API 호출 없이 고정 응답. `IDENTIFY_PROVIDER=mock`. 테스트는 이 제공자 또는 Playwright 라우트 가로채기를 사용합니다.
  - mock은 요청 본문의 `width`/`height`와 무관하게 아래 두 식물을 반환합니다.
    - `p1` 동백나무 bbox `{x:0.10, y:0.15, w:0.35, h:0.50}` confidence 0.91
    - `p2` 수국 bbox `{x:0.55, y:0.30, w:0.35, h:0.45}` confidence 0.78
  - 특수 입력: base64 디코딩 후 첫 바이트 검사 없이, 요청에 `"debug": "too_dark" | "too_far" | "blurry" | "no_plant"` 필드가 있으면 그 quality를 반환합니다 (mock에서만).

## 4. 클라이언트 모듈 인터페이스 (`public/js/`)

### `camera.js` (브라우저 전용)

```js
export async function startCamera(videoEl, { facingMode = "environment" } = {})
// -> { stream, track, torchSupported: boolean }
// 실패 시 Error를 throw. error.code: "denied" | "not_found" | "insecure" | "unknown"

export function captureFrame(videoEl, { maxSide = 1024, quality = 0.85 } = {})
// -> { dataUrl: "data:image/jpeg;base64,...", base64: "...", width, height, imageData: ImageData }
// imageData는 품질 분석용으로 긴 변 160px로 축소한 별도 샘플이다 (전체 프레임 축소본이 아님).
// videoEl.videoWidth가 0이면 null 반환.

export async function setTorch(track, on)
// -> boolean (실제 적용 여부). 미지원이면 false, throw하지 않음.

export function stopCamera(stream)
```

### `quality.js` (순수 함수, Node에서도 import 가능)

```js
export const THRESHOLDS = { darkLuma: 40, blurVar: 60 }
// darkLuma: 평균 밝기(0..255)가 이 값 미만이면 too_dark
// blurVar: 그레이스케일 라플라시안 분산이 이 값 미만이면 blurry

export function analyzeFrame({ data, width, height })
// data: Uint8ClampedArray RGBA. -> { luminance: number, sharpness: number, verdict: "ok" | "too_dark" | "blurry" }
// 판정 순서: too_dark 우선, 그 다음 blurry.

export function frameDiff(a, b)
// a, b: { data, width, height } 같은 크기. -> 0..1 (평균 절대 차이 / 255). 크기가 다르면 1 반환.

export function hintFor(verdictOrQuality, { torchSupported = false } = {})
// -> 한국어 안내 문구 문자열 또는 null (ok일 때).
// too_dark: torchSupported면 "너무 어둡습니다. 플래시를 켜거나 더 밝은 곳에서 비춰 주세요."
//           아니면 "너무 어둡습니다. 더 밝은 곳에서 비추거나 기기 손전등을 켜 주세요."
// too_far:  "식물이 너무 멀리 있습니다. 더 가까이 다가가 주세요."
// blurry:   "화면이 흔들립니다. 카메라를 잠시 고정해 주세요."
// no_plant: "화면에서 식물을 찾지 못했습니다. 식물이 화면 가운데 오도록 비춰 주세요."
```

### `scanner.js` (브라우저 전용, 자동 스캔 루프)

```js
export function createScanner({
  capture,          // () => captureFrame 결과 또는 null
  analyze,          // (imageData) => analyzeFrame 결과
  diff,             // (a, b) => frameDiff 결과
  identify,         // ({ base64, width, height }) => Promise<IdentifyResponse>
  onHint,           // (message_ko | null) => void   품질 안내 표시/해제
  onResult,         // (IdentifyResponse) => void
  onError,          // (Error) => void
  onBusy,           // (boolean) => void   요청 중 표시
  minIntervalMs = 2500,
  stableDiff = 0.06,     // 이전 샘플과의 diff가 이 값 이하이면 "안정"
  sceneChangeDiff = 0.18 // 마지막 결과 시점 샘플 대비 diff가 이 값 이상이면 결과를 무효화하고 재스캔
})
// -> { start(), stop(), scanNow(), isRunning() }
// 규칙:
// - 약 250ms 간격으로 샘플링. verdict가 ok가 아니면 onHint(hintFor(verdict))를 호출하고 요청하지 않는다.
// - 안정(stableDiff 이하)이고 마지막 요청으로부터 minIntervalMs 이상 지났을 때만 identify 호출.
// - 결과가 있으면 씬이 sceneChangeDiff 이상 바뀔 때까지 다시 요청하지 않는다.
// - identify 응답의 quality가 ok가 아니면 onHint(response.message_ko).
// - 동시에 두 요청을 보내지 않는다. scanNow()는 간격/안정 조건을 무시하고 즉시 한 번 요청한다.
```

### `overlay-math.js` (순수 함수, Node에서도 import 가능)

```js
export function computeCoverGeometry({ videoW, videoH, elemW, elemH })
// object-fit: cover 기준. -> { scale, dispW, dispH, offsetX, offsetY }
// scale = max(elemW/videoW, elemH/videoH); offset은 중앙 정렬이라 0 또는 음수.

export function mapBBox(bbox, geometry)
// bbox {x,y,w,h} 정규화 -> 화면 픽셀 { left, top, width, height } (요소 기준 좌표, 클램프 안 함)

export function anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin = 8 })
// rect: mapBBox 결과. 툴팁을 bbox 상단 중앙에 두되 화면 밖으로 나가면 안쪽으로 이동.
// -> { left, top } (툴팁 좌상단, 요소 기준). 항상 [margin, elemW - tipW - margin] 범위로 클램프.
```

### `overlay.js` (브라우저 전용)

```js
export function renderOverlay(container, plants, { videoEl, onSelect })
// container: position:relative인 오버레이 div (비디오와 같은 크기). 기존 내용을 지우고 다시 그린다.
// 각 식물마다 .plant-box (테두리)와 .plant-tip (툴팁 버튼, 텍스트는 name_ko, data-plant-id 속성)을 그린다.
// 툴팁 클릭/터치 시 onSelect(plant) 호출. 툴팁은 role="button", tabindex="0", 키보드 Enter/Space도 처리.
// 리사이즈 및 회전 시 재배치가 필요하므로 renderOverlay는 멱등이어야 한다.

export function clearOverlay(container)
```

### `sheet.js` (브라우저 전용)

```js
export function openSheet(sheetEl, plant)
// sheetEl 내부에 name_ko, name_sci(이탤릭), name_en, family_ko, confidence(%), tags, summary_ko, detail_ko를 채우고 표시.
// 닫기 버튼(.sheet-close), 배경 탭, Escape 키로 닫힘. aria-hidden 토글.

export function closeSheet(sheetEl)
```

### `api.js`

```js
export async function identify({ base64, width, height, lang = "ko", signal })
// POST /api/identify. 20초 타임아웃. 비정상 응답이면 Error를 throw하고 error.code, error.message_ko를 채운다.
```

### `app.js` (오케스트레이터)

- DOM id: `#video`, `#overlay`, `#hint`, `#status`, `#sheet`, `#btn-scan`, `#btn-torch`, `#btn-toggle-auto`.
- 카메라 시작 -> 스캐너 시작 -> 결과를 overlay에 그림 -> 툴팁 선택 시 sheet 열기.
- 리사이즈/회전 시 마지막 결과로 overlay를 다시 그림.
- 오류 시 `#hint`에 한국어 안내.

## 5. 문체 규칙

- 사용자에게 보이는 모든 문자열은 한국어, 존댓말.
- 어떤 파일에서도 em dash(U+2014)와 en dash(U+2013)를 쓰지 않는다. 쉼표, 마침표, 괄호, 세미콜론으로 대체.
