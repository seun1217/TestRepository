# Garden Lens

카메라로 비추기만 하면 화면에 보이는 식물의 이름과 주요 정보를 알려주는 모바일 웹앱(PWA)입니다. 순천만 국가정원처럼 이름 팻말이 없는 정원에서 쓰는 것을 목표로 만들었습니다.

## 주요 기능

- **자동 인식**: 카메라를 식물에 비추고 잠시 멈추면 자동으로 인식합니다. 화면이 크게 바뀔 때까지 같은 결과를 유지하므로 요청이 과도하게 나가지 않습니다.
- **여러 식물 동시 표시**: 화면에 여러 식물이 잡히면 각 식물 위에 이름 툴팁을 띄웁니다. 툴팁을 터치하면 학명, 과명, 특징, 개화기, 구별 포인트 등 상세 설명이 바텀 시트로 열립니다.
- **촬영 조건 안내**: 너무 어둡거나(플래시 또는 밝은 곳 안내), 너무 멀거나(더 가까이 안내), 흔들리면(고정 안내) 요청을 보내기 전에 브라우저에서 먼저 알려줍니다. 서버 모델도 같은 판정을 한 번 더 해서 정확도를 보완합니다.
- **플래시**: 기기가 지원하면(주로 Android Chrome) 앱 안에서 플래시를 켤 수 있습니다.
- **수동 인식**: 자동 인식을 끄고 "지금 인식" 버튼으로 원할 때만 인식할 수 있습니다.

## 동작 방식

1. 브라우저가 `getUserMedia`로 후면 카메라를 엽니다.
2. 250 ms마다 작은 샘플(긴 변 160 px)을 떠서 평균 밝기와 라플라시안 분산으로 어둡거나 흔들리는지 판정합니다. 문제가 있으면 안내만 띄우고 요청을 보내지 않습니다.
3. 화면이 안정되면 긴 변 1024 px JPEG를 서버 `POST /api/identify`로 보냅니다.
4. 서버(Express)가 Anthropic API(Claude 비전)를 호출해 식물 목록을 JSON으로 받습니다. 각 항목에는 정규화된 bbox(0..1)가 있어 화면 좌표로 변환해 툴팁을 올립니다. API 키는 서버에만 있습니다.
5. `object-fit: cover`로 잘린 비디오 영역과 원본 프레임의 차이를 계산해 툴팁이 실제 식물 위에 오도록 맞춥니다.

인터페이스 세부 사항은 [docs/CONTRACT.md](docs/CONTRACT.md)에 있습니다.

## 실행

요구 사항: Node.js 20 이상, Anthropic API 키.

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY를 채웁니다
set -a; source .env; set +a
npm start              # http://localhost:3000
```

API 키 없이 UI만 볼 때는 mock 제공자를 씁니다.

```bash
npm run dev            # IDENTIFY_PROVIDER=mock, 고정된 두 식물을 반환
```

휴대폰에서 쓰려면 **HTTPS**가 필요합니다(브라우저가 `localhost` 외의 HTTP 주소에서는 카메라를 열어 주지 않습니다). 개발 중에는 `ngrok`, `cloudflared` 같은 터널이나 리버스 프록시 뒤에 두고 접속하세요. 리버스 프록시 뒤에서 IP별 요청 제한이 제대로 동작하려면 `TRUST_PROXY=1`을 설정합니다.

### 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | 없음 | 필수. 서버에서만 사용 |
| `IDENTIFY_PROVIDER` | `claude` | `claude` 또는 `mock` |
| `CLAUDE_MODEL` | `claude-opus-5` | 비전 인식에 쓸 모델 |
| `PORT` | `3000` | 서버 포트 |
| `RATE_LIMIT_PER_MIN` | `20` | IP당 분당 인식 요청 제한, `0`이면 해제 |
| `TRUST_PROXY` | 없음 | 프록시 뒤에 있을 때 `1` |

## 테스트

```bash
npm run test:unit   # node:test, 순수 함수와 서버 계약
npm run test:e2e    # Playwright, 가짜 카메라 스트림과 mock 제공자로 전체 흐름 검증
npm test            # 둘 다
```

E2E 테스트는 캔버스 기반의 가짜 카메라(밝은 장면, 어두운 장면, 밋밋한 장면)를 주입해 안내 문구와 툴팁 배치를 검증합니다. 실제 기기 카메라, 플래시, 모델 정확도는 자동 테스트 범위 밖이므로 휴대폰에서 직접 확인해야 합니다.

## 알아둘 점

- **비용**: 인식 한 번에 모델 호출 한 번이 발생합니다. 자동 모드는 화면이 안정되고 크게 바뀐 경우에만 요청하며, 최소 간격은 2.5초입니다. 서버는 IP당 분당 20회로 제한합니다.
- **bbox 정확도**: 모델이 돌려주는 좌표는 툴팁을 식물 근처에 놓을 정도로는 충분하지만 픽셀 단위로 정확하지는 않습니다.
- **플래시**: `MediaStreamTrack.applyConstraints({ torch })`는 Android Chrome에서만 동작합니다. iOS Safari에서는 기기 손전등을 켜라는 안내로 대체합니다.
- **정확도**: 모델은 확신이 낮으면 confidence를 낮춰 답하도록 지시받으며, 서버는 0.35 미만 항목을 걸러냅니다. 그래도 오인식은 있을 수 있으니 학명과 설명을 함께 보고 판단하세요.

## 구조

```
server.js              Express: 정적 파일 + /api/identify 프록시, 응답 정규화, 요청 제한
providers/claude.js    Anthropic SDK 호출, 구조화 출력(JSON schema)
providers/mock.js      개발/테스트용 고정 응답
public/index.html      화면 골격
public/css/app.css     스타일
public/js/app.js       오케스트레이터
public/js/camera.js    카메라 열기, 프레임 캡처, 플래시
public/js/quality.js   밝기/선명도/변화량 계산(순수 함수)
public/js/scanner.js   자동 인식 루프(안정성, 최소 간격, 장면 변화)
public/js/overlay-math.js  cover 크롭 보정과 툴팁 위치 계산(순수 함수)
public/js/overlay.js   툴팁과 테두리 렌더링
public/js/sheet.js     상세 설명 바텀 시트
public/js/api.js       서버 호출
tests/unit             node:test
tests/e2e              Playwright
docs/CONTRACT.md       모듈 계약
```

## 라이선스

[LICENSE](LICENSE) 파일을 참고하세요.
