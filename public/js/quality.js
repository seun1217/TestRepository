// 프레임 품질 분석 (순수 함수). docs/CONTRACT.md 4절 quality.js.
// DOM이나 window를 참조하지 않으므로 Node의 node:test에서도 그대로 import할 수 있다.
export const THRESHOLDS = { darkLuma: 40, blurVar: 60 };

const HINTS = {
  too_dark_torch: "너무 어둡습니다. 플래시를 켜거나 더 밝은 곳에서 비춰 주세요.",
  too_dark: "너무 어둡습니다. 더 밝은 곳에서 비추거나 기기 손전등을 켜 주세요.",
  too_far: "식물이 너무 멀리 있습니다. 더 가까이 다가가 주세요.",
  blurry: "화면이 흔들립니다. 카메라를 잠시 고정해 주세요.",
  no_plant: "화면에서 식물을 찾지 못했습니다. 식물이 화면 가운데 오도록 비춰 주세요.",
};

// RGBA 배열을 픽셀당 하나의 그레이스케일 값(0..255)으로 바꾼다. 유효 픽셀 수만큼만 채운다.
function toGray(data, width, height) {
  const w = width | 0;
  const h = height | 0;
  if (!data || w <= 0 || h <= 0) return { gray: new Float32Array(0), width: 0, height: 0 };
  const n = Math.min(w * h, Math.floor(data.length / 4));
  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return { gray, width: w, height: h };
}

// 4방향 라플라시안(4*중앙 - 상하좌우)의 분산. 내부 픽셀만 계산한다.
function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3 || gray.length < width * height) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = 4 * gray[i] - gray[i - width] - gray[i + width] - gray[i - 1] - gray[i + 1];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

export function analyzeFrame({ data, width, height } = {}) {
  const { gray, width: w, height: h } = toGray(data, width, height);
  let luminance = 0;
  if (gray.length > 0) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    luminance = sum / gray.length;
  }
  const sharpness = laplacianVariance(gray, w, h);
  // 3x3보다 작은 이미지는 라플라시안을 계산할 수 없으므로 흐림 판정을 하지 않는다.
  const canJudgeBlur = w >= 3 && h >= 3 && gray.length >= w * h;
  let verdict = "ok";
  if (luminance < THRESHOLDS.darkLuma) verdict = "too_dark";
  else if (canJudgeBlur && sharpness < THRESHOLDS.blurVar) verdict = "blurry";
  return { luminance, sharpness, verdict };
}

export function frameDiff(a, b) {
  if (!a || !b || !a.data || !b.data) return 1;
  if (a.width !== b.width || a.height !== b.height) return 1;
  const ga = toGray(a.data, a.width, a.height).gray;
  const gb = toGray(b.data, b.width, b.height).gray;
  if (ga.length === 0 || ga.length !== gb.length) return 1;
  let sum = 0;
  for (let i = 0; i < ga.length; i++) sum += Math.abs(ga[i] - gb[i]);
  const diff = sum / ga.length / 255;
  return Math.min(1, Math.max(0, diff));
}

export function hintFor(verdictOrQuality, { torchSupported = false } = {}) {
  switch (verdictOrQuality) {
    case "too_dark":
      return torchSupported ? HINTS.too_dark_torch : HINTS.too_dark;
    case "too_far":
      return HINTS.too_far;
    case "blurry":
      return HINTS.blurry;
    case "no_plant":
      return HINTS.no_plant;
    default:
      return null;
  }
}
