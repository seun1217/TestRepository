// 오버레이 좌표 계산 (순수 함수). docs/CONTRACT.md 4절 overlay-math.js. 구현은 워크플로우 에이전트가 채운다.
export function computeCoverGeometry({ videoW, videoH, elemW, elemH }) {
  return { scale: 1, dispW: elemW, dispH: elemH, offsetX: 0, offsetY: 0 };
}

export function mapBBox(bbox, geometry) {
  return { left: 0, top: 0, width: 0, height: 0 };
}

export function anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin = 8 }) {
  return { left: 0, top: 0 };
}
