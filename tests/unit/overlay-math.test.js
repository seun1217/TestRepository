// overlay-math.js 단위 테스트. object-fit: cover 기하와 툴팁 배치 규칙을 검사한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverGeometry, mapBBox, anchorTooltip, resolveOverlaps } from "../../public/js/overlay-math.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${a} to be within ${eps} of ${b}`);
const centerBox = { x: 0.5, y: 0.5, w: 0, h: 0 };

test("computeCoverGeometry: 세로 비디오(1080x1920)를 390x600 요소에 cover로 맞추면 폭이 기준이 된다", () => {
  const g = computeCoverGeometry({ videoW: 1080, videoH: 1920, elemW: 390, elemH: 600 });
  near(g.scale, 390 / 1080);
  near(g.dispW, 390);
  near(g.dispH, 1920 * (390 / 1080));
  near(g.offsetX, 0);
  assert.ok(g.offsetY < 0, "세로 방향으로 넘치므로 offsetY는 음수여야 한다");
  near(g.offsetY, (600 - 1920 * (390 / 1080)) / 2);
  const c = mapBBox(centerBox, g);
  near(c.left, 195);
  near(c.top, 300);
});

test("computeCoverGeometry: 가로 비디오(1920x1080)를 390x844 요소에 cover로 맞추면 높이가 기준이 된다", () => {
  const g = computeCoverGeometry({ videoW: 1920, videoH: 1080, elemW: 390, elemH: 844 });
  near(g.scale, 844 / 1080);
  near(g.dispH, 844);
  near(g.dispW, 1920 * (844 / 1080));
  near(g.offsetY, 0);
  assert.ok(g.offsetX < 0, "가로 방향으로 넘치므로 offsetX는 음수여야 한다");
  near(g.offsetX, (390 - 1920 * (844 / 1080)) / 2);
  const c = mapBBox(centerBox, g);
  near(c.left, 195);
  near(c.top, 422);
});

test("computeCoverGeometry: 비디오와 요소 크기가 같으면 항등 변환이다", () => {
  const g = computeCoverGeometry({ videoW: 390, videoH: 600, elemW: 390, elemH: 600 });
  assert.deepEqual(g, { scale: 1, dispW: 390, dispH: 600, offsetX: 0, offsetY: 0 });
  const r = mapBBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, g);
  near(r.left, 39);
  near(r.top, 120);
  near(r.width, 195);
  near(r.height, 150);
});

test("computeCoverGeometry: 비디오 크기가 0이거나 비정상이면 요소 크기 그대로 scale 1을 돌려준다", () => {
  const expected = { scale: 1, dispW: 390, dispH: 600, offsetX: 0, offsetY: 0 };
  assert.deepEqual(computeCoverGeometry({ videoW: 0, videoH: 0, elemW: 390, elemH: 600 }), expected);
  assert.deepEqual(computeCoverGeometry({ videoW: NaN, videoH: 1080, elemW: 390, elemH: 600 }), expected);
  assert.deepEqual(computeCoverGeometry({ videoW: 1920, videoH: Infinity, elemW: 390, elemH: 600 }), expected);
  assert.deepEqual(computeCoverGeometry({ videoW: 1920, videoH: 1080, elemW: 0, elemH: 0 }), {
    scale: 1, dispW: 0, dispH: 0, offsetX: 0, offsetY: 0,
  });
});

test("mapBBox: 클램프하지 않으므로 화면 밖 좌표도 그대로 돌려준다", () => {
  const g = computeCoverGeometry({ videoW: 1920, videoH: 1080, elemW: 390, elemH: 844 });
  const r = mapBBox({ x: 0, y: 0, w: 1, h: 1 }, g);
  assert.ok(r.left < 0);
  near(r.width, g.dispW);
  near(r.left + r.width, 390 - g.offsetX);
});

const elem = { elemW: 390, elemH: 600, tipW: 100, tipH: 30, margin: 8 };

test("anchorTooltip: 기본은 bbox 상단 중앙, 위쪽 6px 간격", () => {
  const p = anchorTooltip({ left: 100, top: 200, width: 100, height: 50 }, elem);
  assert.deepEqual(p, { left: 100, top: 164 });
});

test("anchorTooltip: 정수를 돌려준다", () => {
  const p = anchorTooltip({ left: 100.4, top: 200.6, width: 33.3, height: 50 }, elem);
  assert.ok(Number.isInteger(p.left) && Number.isInteger(p.top));
});

test("anchorTooltip: 왼쪽 가장자리에서 margin으로 클램프", () => {
  const p = anchorTooltip({ left: -50, top: 200, width: 40, height: 40 }, elem);
  assert.equal(p.left, 8);
});

test("anchorTooltip: 오른쪽 가장자리에서 elemW - tipW - margin으로 클램프", () => {
  const p = anchorTooltip({ left: 380, top: 200, width: 40, height: 40 }, elem);
  assert.equal(p.left, 390 - 100 - 8);
});

test("anchorTooltip: 위로 넘치면 박스 안쪽 상단(rect.top + 6)에 둔다", () => {
  const p = anchorTooltip({ left: 100, top: 10, width: 100, height: 80 }, elem);
  assert.deepEqual(p, { left: 100, top: 16 });
});

test("anchorTooltip: 박스 자체가 화면 위로 나가면 top도 margin으로 클램프", () => {
  const p = anchorTooltip({ left: 100, top: -30, width: 100, height: 80 }, elem);
  assert.equal(p.top, 8);
});

test("anchorTooltip: 아래쪽 가장자리에서 elemH - tipH - margin으로 클램프", () => {
  const p = anchorTooltip({ left: 100, top: 650, width: 100, height: 40 }, elem);
  assert.equal(p.top, 600 - 30 - 8);
});

test("anchorTooltip: 툴팁이 요소보다 넓으면 (범위 역전) margin을 쓴다", () => {
  const p = anchorTooltip({ left: 100, top: 200, width: 100, height: 50 }, { ...elem, tipW: 500 });
  assert.equal(p.left, 8);
  const q = anchorTooltip({ left: 100, top: 200, width: 100, height: 50 }, { ...elem, tipH: 700 });
  assert.equal(q.top, 8);
});

test("anchorTooltip: margin 기본값은 8이다", () => {
  const p = anchorTooltip({ left: -50, top: 200, width: 40, height: 40 }, { elemW: 390, elemH: 600, tipW: 100, tipH: 30 });
  assert.equal(p.left, 8);
});

test("resolveOverlaps: 겹치는 툴팁은 (height + gap)만큼 아래로 밀려 앞선 툴팁 아래에 놓인다", () => {
  const input = [
    { left: 0, top: 0, width: 100, height: 30 },
    { left: 10, top: 10, width: 100, height: 30 },
  ];
  const out = resolveOverlaps(input);
  assert.deepEqual(out[0], input[0]);
  assert.equal(out[1].top, 10 + 30 + 4);
  assert.ok(out[1].top >= out[0].top + out[0].height, "앞선 툴팁 아래에 있어야 한다");
  assert.equal(out[1].left, 10);
  assert.equal(input[1].top, 10, "입력 배열은 바뀌지 않아야 한다");
  assert.notEqual(out, input);
});

test("resolveOverlaps: 세 개가 같은 자리면 순서대로 쌓인다", () => {
  const same = { left: 20, top: 40, width: 80, height: 20 };
  const out = resolveOverlaps([{ ...same }, { ...same }, { ...same }], { gap: 2 });
  assert.deepEqual(out.map((p) => p.top), [40, 62, 84]);
});

test("resolveOverlaps: 겹치지 않는 툴팁은 그대로 둔다", () => {
  const input = [
    { left: 0, top: 0, width: 100, height: 30 },
    { left: 0, top: 100, width: 100, height: 30 },
    { left: 200, top: 0, width: 100, height: 30 },
    { left: 0, top: 30, width: 100, height: 30 },
  ];
  assert.deepEqual(resolveOverlaps(input), input);
});

test("resolveOverlaps: 빈 배열이면 빈 배열", () => {
  assert.deepEqual(resolveOverlaps([]), []);
});
