// E2E 공용 헬퍼: 캔버스 기반 가짜 카메라 주입, /api/identify 요청 계수, 앱 진입.
// Chromium의 가짜 장치 패턴은 움직여서 스캐너의 안정 판정을 통과하지 못하므로 정지 화면을 직접 만든다.
import { expect } from "@playwright/test";

export const CAMERA_W = 640;
export const CAMERA_H = 480;

// 페이지 스크립트보다 먼저 실행된다 (addInitScript). 이 시점에는 document.body가 없다.
function fakeCameraInit(variant) {
  const W = 640;
  const H = 480;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // 매번 같은 내용을 그린다. 프레임 간 차이가 0이어야 스캐너가 "안정"으로 본다.
  function draw() {
    if (variant === "dark") {
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (variant === "flat") {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, W, H);
      return;
    }
    // bright: 밝은 배경 위에 촘촘한 고대비 체커보드와 고정 위치의 점들 (라플라시안 분산을 높인다).
    ctx.fillStyle = "#e6e6e6";
    ctx.fillRect(0, 0, W, H);
    const cell = 20;
    ctx.fillStyle = "#202020";
    for (let y = 0; y < H; y += cell) {
      for (let x = 0; x < W; x += cell) {
        if (((x / cell + y / cell) & 1) === 0) ctx.fillRect(x, y, cell, cell);
      }
    }
    // 결정적인 의사 난수 점들 (선형 합동 생성기, 시드 고정).
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 400; i++) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * H);
      ctx.fillStyle = rand() > 0.5 ? "#ffffff" : "#000000";
      ctx.fillRect(x, y, 6, 6);
    }
  }

  draw();
  const stream = canvas.captureStream(15);
  const track = stream.getVideoTracks()[0];
  // 플래시 미지원 장치처럼 보이게 한다.
  track.getCapabilities = () => ({});
  track.applyConstraints = () =>
    Promise.reject(new DOMException("torch is not supported", "NotSupportedError"));

  setInterval(() => {
    draw();
    try {
      if (typeof track.requestFrame === "function") track.requestFrame();
    } catch {
      // 트랙이 이미 멈췄으면 무시한다.
    }
  }, 100);

  const media = navigator.mediaDevices;
  media.getUserMedia = async () => stream;
  window.__fakeCamera = { variant, canvas, stream, track };
}

// variant: "bright" | "dark" | "flat". page.goto 전에 호출해야 한다.
export async function installFakeCamera(page, variant = "bright") {
  await page.addInitScript(fakeCameraInit, variant);
}

// POST /api/identify 요청 수를 센다. page.goto 전에 호출해야 한다.
export function countIdentifyRequests(page) {
  const counter = { count: 0 };
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    let pathname = "";
    try {
      pathname = new URL(req.url()).pathname;
    } catch {
      return;
    }
    if (pathname === "/api/identify") counter.count += 1;
  });
  return counter;
}

// 앱을 열고 비디오가 실제 프레임을 받을 때까지 기다린다.
export async function gotoApp(page) {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => document.querySelector("#video")?.videoWidth || 0), { timeout: 8000 })
    .toBeGreaterThan(0);
}

export async function waitForTips(page, count = 2, timeout = 8000) {
  const tips = page.locator("#overlay .plant-tip");
  await expect(tips).toHaveCount(count, { timeout });
  return tips;
}

// 각 툴팁의 style.left/top (컨테이너 기준 픽셀).
export function tipPositions(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#overlay .plant-tip")).map((tip) => ({
      id: tip.dataset.plantId,
      left: Number.parseFloat(tip.style.left),
      top: Number.parseFloat(tip.style.top),
    })),
  );
}

// 모든 툴팁의 실제 화면 사각형이 #viewport 안에 있는지 확인한다.
export async function expectTipsInsideViewport(page, tips) {
  const vp = await page.locator("#viewport").boundingBox();
  expect(vp).not.toBeNull();
  const n = await tips.count();
  for (let i = 0; i < n; i++) {
    const box = await tips.nth(i).boundingBox();
    expect(box, `tip ${i} has a bounding box`).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(vp.x - 0.5);
    expect(box.y).toBeGreaterThanOrEqual(vp.y - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.x + vp.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.y + vp.height + 0.5);
  }
}
