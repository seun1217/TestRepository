// quality.js 단위 테스트. ImageData 모양의 객체를 직접 합성해 검사한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { THRESHOLDS, analyzeFrame, frameDiff, hintFor } from "../../public/js/quality.js";

// 픽셀마다 (x, y) => [r, g, b]를 돌려주는 함수로 ImageData 모양 객체를 만든다.
function makeImage(width, height, pixelFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const flat = (w, h, v) => makeImage(w, h, () => [v, v, v]);
const checkerboard = (w, h) => makeImage(w, h, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));

test("THRESHOLDS는 계약 값을 유지한다", () => {
  assert.deepEqual(THRESHOLDS, { darkLuma: 40, blurVar: 60 });
});

test("analyzeFrame: 검은 프레임은 too_dark", () => {
  const r = analyzeFrame(flat(16, 12, 0));
  assert.equal(r.luminance, 0);
  assert.equal(r.verdict, "too_dark");
});

test("analyzeFrame: 어두운 프레임은 밝기와 무관하게 too_dark가 blurry보다 우선한다", () => {
  const r = analyzeFrame(flat(16, 12, 30));
  assert.ok(r.luminance < THRESHOLDS.darkLuma);
  assert.equal(r.sharpness, 0);
  assert.equal(r.verdict, "too_dark");
});

test("analyzeFrame: 평평한 밝은 회색은 blurry", () => {
  const r = analyzeFrame(flat(16, 12, 128));
  assert.ok(Math.abs(r.luminance - 128) < 1e-6);
  assert.equal(r.sharpness, 0);
  assert.equal(r.verdict, "blurry");
});

test("analyzeFrame: 고대비 체커보드는 ok이며 선명도가 높다", () => {
  const r = analyzeFrame(checkerboard(16, 12));
  assert.ok(Math.abs(r.luminance - 127.5) < 1e-6);
  assert.ok(r.sharpness > THRESHOLDS.blurVar);
  assert.equal(r.verdict, "ok");
});

test("analyzeFrame: 밝기는 0.299R + 0.587G + 0.114B의 평균이다", () => {
  const r = analyzeFrame(makeImage(4, 4, () => [100, 200, 50]));
  const expected = 0.299 * 100 + 0.587 * 200 + 0.114 * 50;
  assert.ok(Math.abs(r.luminance - expected) < 1e-6);
});

test("analyzeFrame: 라플라시안 분산은 내부 픽셀만 계산한다", () => {
  // 가운데 픽셀만 밝은 5x5 이미지. 테두리는 계산에서 제외되므로 3x3 내부 9개만 본다.
  const img = makeImage(5, 5, (x, y) => (x === 2 && y === 2 ? [255, 255, 255] : [100, 100, 100]));
  const r = analyzeFrame(img);
  // 내부 9개 라플라시안: 중앙 4*155=620, 상하좌우 4개 -155, 대각 4개 0.
  const values = [620, -155, -155, -155, -155, 0, 0, 0, 0];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  assert.ok(Math.abs(r.sharpness - variance) < 1e-6);
});

test("analyzeFrame: 3x3보다 작은 이미지는 선명도 0이지만 blurry로 판정하지 않는다", () => {
  const r = analyzeFrame(flat(2, 2, 200));
  assert.equal(r.sharpness, 0);
  assert.equal(r.verdict, "ok");
  const dark = analyzeFrame(flat(2, 2, 10));
  assert.equal(dark.verdict, "too_dark");
});

test("analyzeFrame: 잘못된 입력에도 throw하지 않는다", () => {
  assert.equal(analyzeFrame({}).verdict, "too_dark");
  assert.equal(analyzeFrame({ data: new Uint8ClampedArray(0), width: 0, height: 0 }).verdict, "too_dark");
});

test("frameDiff: 동일 프레임은 0", () => {
  const a = checkerboard(10, 8);
  const b = checkerboard(10, 8);
  assert.equal(frameDiff(a, b), 0);
});

test("frameDiff: 검정 대 흰색은 1", () => {
  assert.equal(frameDiff(flat(8, 8, 0), flat(8, 8, 255)), 1);
});

test("frameDiff: 절반 정도 다르면 약 0.5", () => {
  const d = frameDiff(flat(8, 8, 0), flat(8, 8, 128));
  assert.ok(Math.abs(d - 128 / 255) < 1e-6);
});

test("frameDiff: 크기가 다르면 1", () => {
  assert.equal(frameDiff(flat(8, 8, 100), flat(8, 6, 100)), 1);
  assert.equal(frameDiff(flat(8, 8, 100), flat(4, 8, 100)), 1);
});

test("frameDiff: 한쪽이 없으면 1", () => {
  assert.equal(frameDiff(null, flat(8, 8, 100)), 1);
  assert.equal(frameDiff(flat(8, 8, 100), undefined), 1);
  assert.equal(frameDiff(null, null), 1);
});

test("hintFor: 계약 문구를 그대로 돌려준다", () => {
  assert.equal(hintFor("too_dark", { torchSupported: true }), "너무 어둡습니다. 플래시를 켜거나 더 밝은 곳에서 비춰 주세요.");
  assert.equal(hintFor("too_dark", { torchSupported: false }), "너무 어둡습니다. 더 밝은 곳에서 비추거나 기기 손전등을 켜 주세요.");
  assert.equal(hintFor("too_dark"), "너무 어둡습니다. 더 밝은 곳에서 비추거나 기기 손전등을 켜 주세요.");
  assert.equal(hintFor("too_far"), "식물이 너무 멀리 있습니다. 더 가까이 다가가 주세요.");
  assert.equal(hintFor("blurry"), "화면이 흔들립니다. 카메라를 잠시 고정해 주세요.");
  assert.equal(hintFor("no_plant"), "화면에서 식물을 찾지 못했습니다. 식물이 화면 가운데 오도록 비춰 주세요.");
});

test("hintFor: ok와 알 수 없는 값은 null", () => {
  assert.equal(hintFor("ok"), null);
  assert.equal(hintFor("something_else"), null);
  assert.equal(hintFor(undefined), null);
  assert.equal(hintFor(null), null);
});
