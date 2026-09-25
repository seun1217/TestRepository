// 오버레이 좌표 계산 (순수 함수). docs/CONTRACT.md 4절 overlay-math.js.
// DOM, window를 참조하지 않으므로 Node의 node:test에서도 그대로 import할 수 있다.

const isPositive = (v) => Number.isFinite(v) && v > 0;

// object-fit: cover 기준으로 비디오가 요소 안에서 실제로 그려지는 크기와 위치를 구한다.
// offsetX/offsetY는 중앙 정렬이라 0 또는 음수다. 입력이 0이거나 비정상이면 항등 변환을 돌려준다.
export function computeCoverGeometry({ videoW, videoH, elemW, elemH }) {
  const ew = Number.isFinite(elemW) ? elemW : 0;
  const eh = Number.isFinite(elemH) ? elemH : 0;
  if (!isPositive(videoW) || !isPositive(videoH) || !isPositive(ew) || !isPositive(eh)) {
    return { scale: 1, dispW: ew, dispH: eh, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(ew / videoW, eh / videoH);
  const dispW = videoW * scale;
  const dispH = videoH * scale;
  return {
    scale,
    dispW,
    dispH,
    offsetX: (ew - dispW) / 2,
    offsetY: (eh - dispH) / 2,
  };
}

// 정규화 bbox {x,y,w,h} (0..1) -> 요소 기준 픽셀 사각형. 클램프하지 않는다 (잘림은 CSS overflow가 담당).
export function mapBBox(bbox, geometry) {
  const { x = 0, y = 0, w = 0, h = 0 } = bbox || {};
  const { dispW, dispH, offsetX, offsetY } = geometry;
  return {
    left: offsetX + x * dispW,
    top: offsetY + y * dispH,
    width: w * dispW,
    height: h * dispH,
  };
}

// [lo, hi] 범위로 클램프한다. 범위가 뒤집혀 있으면 (툴팁이 요소보다 클 때) lo를 돌려준다.
function clampRange(v, lo, hi) {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}

// 툴팁을 bbox 상단 중앙에 둔다. 위로 넘치면 박스 안쪽 상단으로 옮기고, 항상 요소 안쪽 margin 범위로 클램프한다.
export function anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin = 8 }) {
  let left = rect.left + (rect.width - tipW) / 2;
  let top = rect.top - tipH - 6;
  if (top < margin) top = rect.top + 6;
  left = clampRange(left, margin, elemW - tipW - margin);
  top = clampRange(top, margin, elemH - tipH - margin);
  return { left: Math.round(left), top: Math.round(top) };
}

const intersects = (a, b) =>
  a.left < b.left + b.width &&
  a.left + a.width > b.left &&
  a.top < b.top + b.height &&
  a.top + a.height > b.top;

// 앞선 툴팁과 겹치는 툴팁을 자기 높이 + gap만큼 아래로 반복해서 밀어 겹침을 푼다.
// 새 배열을 돌려주며 입력은 바꾸지 않는다. 이동량은 최소 1px이라 항상 끝난다.
export function resolveOverlaps(placements, { gap = 4 } = {}) {
  const out = [];
  for (const p of placements) {
    const cur = { ...p };
    const step = Math.max(cur.height + gap, 1);
    while (out.some((prev) => intersects(cur, prev))) {
      cur.top += step;
    }
    out.push(cur);
  }
  return out;
}
