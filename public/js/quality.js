// 프레임 품질 분석 (순수 함수). docs/CONTRACT.md 4절 quality.js. 구현은 워크플로우 에이전트가 채운다.
export const THRESHOLDS = { darkLuma: 40, blurVar: 60 };

export function analyzeFrame({ data, width, height }) {
  return { luminance: 0, sharpness: 0, verdict: "ok" };
}

export function frameDiff(a, b) {
  return 1;
}

export function hintFor(verdictOrQuality, { torchSupported = false } = {}) {
  return null;
}
