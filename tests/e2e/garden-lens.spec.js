// Garden Lens 전체 흐름 E2E. mock 제공자(동백나무, 수국)와 캔버스 기반 가짜 카메라를 쓴다.
import { test, expect } from "@playwright/test";
import {
  installFakeCamera,
  countIdentifyRequests,
  gotoApp,
  waitForTips,
  tipPositions,
  expectTipsInsideViewport,
  lastFrameInfo,
  waitForIdentifyRequest,
  CAMERA_W,
  CAMERA_H,
} from "./helpers.js";

const TOO_FAR_MESSAGE = "식물이 너무 멀리 있습니다. 더 가까이 다가가 주세요.";

test("boot and auto identification renders two tooltips at the computed positions", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await gotoApp(page);

  await expect(page.locator("#video")).toHaveJSProperty("videoWidth", 640);
  await expect(page.locator("#app")).toHaveAttribute("data-state", /^(ready|busy)$/);

  const tips = await waitForTips(page, 2, 8000);
  await expect(tips.filter({ hasText: "동백나무" })).toHaveCount(1);
  await expect(tips.filter({ hasText: "수국" })).toHaveCount(1);
  await expect(page.locator("#overlay .plant-box")).toHaveCount(2);
  await expect(page.locator("#hint")).toBeHidden();
  await expect(page.locator("#status")).toContainText("동백나무, 수국");

  await expectTipsInsideViewport(page, tips);

  // overlay-math.js로 기대 위치를 다시 계산해 실제 style.left/top과 비교한다.
  // bbox는 잘린 이미지 기준이므로 result.frame.crop으로 전체 프레임 기준으로 되돌린 뒤 화면 좌표로 옮긴다.
  const { actual, expected } = await page.evaluate(async () => {
    const m = await import("/js/overlay-math.js");
    const video = document.querySelector("#video");
    const overlay = document.querySelector("#overlay");
    const elemW = overlay.clientWidth;
    const elemH = overlay.clientHeight;
    const geometry = m.computeCoverGeometry({
      videoW: video.videoWidth,
      videoH: video.videoHeight,
      elemW,
      elemH,
    });
    const result = window.__gardenLens.lastResult;
    const crop = result.frame?.crop || null;
    const tipEls = Array.from(overlay.querySelectorAll(".plant-tip"));
    const placements = tipEls.map((tip) => {
      const plant = result.plants.find((p) => p.id === tip.dataset.plantId);
      const rect = m.mapBBox(m.cropToVideoBBox(plant.bbox, crop), geometry);
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const { left, top } = m.anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin: 8 });
      return { left, top, width: tipW, height: tipH };
    });
    const resolved = m.resolveOverlaps(placements, { gap: 4 });
    return {
      actual: tipEls.map((tip) => ({
        id: tip.dataset.plantId,
        left: Number.parseFloat(tip.style.left),
        top: Number.parseFloat(tip.style.top),
      })),
      expected: resolved.map((r, i) => ({ id: tipEls[i].dataset.plantId, left: r.left, top: r.top })),
    };
  });
  expect(actual.map((a) => a.id)).toEqual(["p1", "p2"]);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i].left - expected[i].left), `tip ${actual[i].id} left`).toBeLessThanOrEqual(3);
    expect(Math.abs(actual[i].top - expected[i].top), `tip ${actual[i].id} top`).toBeLessThanOrEqual(3);
  }
});

test("capture crops the landscape stream to the portrait view and tooltips land on x*elemW, y*elemH", async ({ page }) => {
  await installFakeCamera(page, "bright");
  const identifyRequest = waitForIdentifyRequest(page);
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const sent = (await identifyRequest).postDataJSON();

  // 가로(640x480) 스트림을 세로 뷰에 cover로 맞추면 양옆이 잘린다: sw < 640, sx > 0, 세로는 그대로.
  const info = await lastFrameInfo(page);
  const { crop } = info;
  expect(info.videoW).toBe(CAMERA_W);
  expect(info.videoH).toBe(CAMERA_H);
  expect(info.viewW).toBeLessThan(info.viewH);
  expect(crop).not.toBeNull();
  expect(crop.videoW).toBe(CAMERA_W);
  expect(crop.videoH).toBe(CAMERA_H);
  expect(crop.sw).toBeLessThan(CAMERA_W);
  expect(crop.sx).toBeGreaterThan(0);
  expect(crop.sy).toBe(0);
  expect(crop.sh).toBe(CAMERA_H);
  expect(crop.sx + crop.sw).toBeLessThanOrEqual(CAMERA_W);
  expect(Math.abs(crop.sx - (CAMERA_W - crop.sw) / 2), "crop is centered").toBeLessThanOrEqual(1);
  expect(Math.abs(crop.sw / crop.sh - info.viewW / info.viewH), "crop aspect matches the view").toBeLessThan(0.02);

  // 보낸 이미지는 잘린 영역의 종횡비를 가지며 확대되지 않는다. 서버로 간 요청 본문도 같은 크기다.
  expect(Math.abs(info.width / info.height - crop.sw / crop.sh), "sent image aspect matches the crop").toBeLessThan(0.02);
  expect(info.width).toBeLessThanOrEqual(crop.sw);
  expect(info.height).toBeLessThanOrEqual(crop.sh);
  expect(sent.width).toBe(info.width);
  expect(sent.height).toBe(info.height);
  expect(sent.image.length).toBe(info.base64Length);

  // 뷰 크기가 캡처 때와 같으므로 박스는 x*elemW, y*elemH에, 툴팁은 그 박스 위 중앙에 놓여야 한다 (가장자리 클램프 없음).
  const layout = await page.evaluate(async () => {
    const m = await import("/js/overlay-math.js");
    const overlay = document.querySelector("#overlay");
    const elemW = overlay.clientWidth;
    const elemH = overlay.clientHeight;
    const plants = window.__gardenLens.lastResult.plants;
    const tipEls = Array.from(overlay.querySelectorAll(".plant-tip"));
    const boxEls = Array.from(overlay.querySelectorAll(".plant-box"));
    const num = (v) => Number.parseFloat(v);
    const expected = tipEls.map((tip) => {
      const { bbox } = plants.find((p) => p.id === tip.dataset.plantId);
      const rect = { left: bbox.x * elemW, top: bbox.y * elemH, width: bbox.w * elemW, height: bbox.h * elemH };
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const { left, top } = m.anchorTooltip(rect, { elemW, elemH, tipW, tipH, margin: 8 });
      return { id: tip.dataset.plantId, rect, left, top, width: tipW, height: tipH };
    });
    const placements = expected.map(({ left, top, width, height }) => ({ left, top, width, height }));
    return {
      elemW,
      elemH,
      expected,
      resolved: m.resolveOverlaps(placements, { gap: 4 }),
      placements,
      tips: tipEls.map((tip) => ({
        id: tip.dataset.plantId,
        left: num(tip.style.left),
        top: num(tip.style.top),
        width: tip.offsetWidth,
      })),
      boxes: boxEls.map((box) => ({
        left: num(box.style.left),
        top: num(box.style.top),
        width: num(box.style.width),
        height: num(box.style.height),
      })),
    };
  });
  expect(layout.tips.map((t) => t.id)).toEqual(["p1", "p2"]);
  expect(layout.boxes).toHaveLength(2);
  // 두 mock 박스는 가로로 떨어져 있어 겹침 해소가 위치를 바꾸지 않는다.
  expect(layout.resolved).toEqual(layout.placements);
  for (let i = 0; i < layout.expected.length; i++) {
    const e = layout.expected[i];
    const box = layout.boxes[i];
    const tip = layout.tips[i];
    expect(Math.abs(box.left - e.rect.left), `box ${e.id} left`).toBeLessThanOrEqual(3);
    expect(Math.abs(box.top - e.rect.top), `box ${e.id} top`).toBeLessThanOrEqual(3);
    expect(Math.abs(box.width - e.rect.width), `box ${e.id} width`).toBeLessThanOrEqual(3);
    expect(Math.abs(box.height - e.rect.height), `box ${e.id} height`).toBeLessThanOrEqual(3);
    expect(Math.abs(tip.left - e.left), `tip ${e.id} left`).toBeLessThanOrEqual(3);
    expect(Math.abs(tip.top - e.top), `tip ${e.id} top`).toBeLessThanOrEqual(3);
  }
  // crop 없이 그렸다면 p1은 왼쪽 margin(8px)에, p2는 오른쪽 가장자리에 붙었을 것이다.
  const [p1, p2] = layout.tips;
  expect(p1.left).toBeGreaterThan(8 + 4);
  expect(p2.left + p2.width).toBeLessThan(layout.elemW - 8 - 4);
  await expectTipsInsideViewport(page, tips);
});

test("tooltip opens the detail sheet, closes, reopens by keyboard and closes with Escape", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const camelliaTip = tips.filter({ hasText: "동백나무" });
  const sheet = page.locator("#sheet");

  await camelliaTip.click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#sheet-title")).toHaveText("동백나무");
  await expect(page.locator("#sheet em[data-field=name_sci]")).toHaveText("Camellia japonica");
  await expect(page.locator("#sheet [data-field=name_en]")).toHaveText("Japanese camellia");
  await expect(page.locator("#sheet [data-field=family_ko]")).toHaveText("차나무과");
  await expect(page.locator("#sheet [data-field=confidence]")).toHaveText("91%");
  await expect(page.locator("#sheet [data-field=tags] li")).toHaveCount(3);
  await expect(page.locator("#sheet [data-field=summary_ko]")).not.toBeEmpty();
  expect(await page.locator("#sheet [data-field=detail_ko] p").count()).toBeGreaterThanOrEqual(2);

  // 닫기 버튼
  await page.locator("#sheet .sheet-close").click();
  await expect(sheet).toHaveAttribute("aria-hidden", "true");
  await expect(sheet).toBeHidden();
  await expect(sheet).toHaveAttribute("hidden", "");

  // 키보드로 다시 열기 (포커스 후 Enter)
  await camelliaTip.focus();
  await expect(camelliaTip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#sheet-title")).toHaveText("동백나무");

  // Escape로 닫기
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveAttribute("aria-hidden", "true");
  await expect(sheet).toBeHidden();
});

test("too dark locally shows a torch hint and sends no request", async ({ page }) => {
  await installFakeCamera(page, "dark");
  const requests = countIdentifyRequests(page);
  const t0 = Date.now();
  await gotoApp(page);

  const hint = page.locator("#hint");
  await expect(hint).toBeVisible({ timeout: 4000 });
  await expect(hint).toContainText("너무 어둡습니다");
  await expect(hint).toContainText(/손전등|플래시/);

  // 안내가 뜬 뒤에도 요청이 나가지 않는지 확인한다 (진입 후 4초까지 관찰).
  await page.waitForTimeout(Math.max(0, 4000 - (Date.now() - t0)));
  expect(requests.count).toBe(0);
  await expect(page.locator("#overlay .plant-tip")).toHaveCount(0);
});

test("server too_far response shows the message and no tooltips", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await page.route("**/api/identify", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        quality: "too_far",
        message_ko: TOO_FAR_MESSAGE,
        plants: [],
        model: "mock",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    }),
  );
  const requests = countIdentifyRequests(page);
  await gotoApp(page);

  await expect.poll(() => requests.count, { timeout: 8000 }).toBeGreaterThan(0);
  const hint = page.locator("#hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText(TOO_FAR_MESSAGE);
  await expect(hint).not.toHaveAttribute("data-kind", "error");
  await expect(page.locator("#overlay .plant-tip")).toHaveCount(0);
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");
});

test("server 502 error shows an error hint and no tooltips", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await page.route("**/api/identify", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "upstream_error", message_ko: "테스트 오류" } }),
    }),
  );
  const requests = countIdentifyRequests(page);
  await gotoApp(page);

  await expect.poll(() => requests.count, { timeout: 8000 }).toBeGreaterThan(0);
  const hint = page.locator("#hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("테스트 오류");
  await expect(hint).toHaveAttribute("data-kind", "error");
  await expect(page.locator("#overlay .plant-tip")).toHaveCount(0);
  // 다음 샘플의 onHint(null)이 오류 안내를 지우지 않아야 한다.
  await page.waitForTimeout(600);
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText("테스트 오류");
});

test("manual scan sends exactly one request after auto mode is turned off", async ({ page }) => {
  await installFakeCamera(page, "bright");
  const requests = countIdentifyRequests(page);
  await gotoApp(page);
  await expect(page.locator("#app")).toHaveAttribute("data-state", /^(ready|busy)$/);

  const btnAuto = page.locator("#btn-toggle-auto");
  await expect(btnAuto).toHaveAttribute("aria-pressed", "true");
  await btnAuto.click();
  await expect(btnAuto).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#status")).toHaveText("자동 인식 꺼짐");
  await expect.poll(() => page.evaluate(() => window.__gardenLens.scanner.isRunning())).toBe(false);

  await page.waitForTimeout(1000);
  const baseline = requests.count;

  await page.locator("#btn-scan").click();
  await expect.poll(() => requests.count, { timeout: 5000 }).toBe(baseline + 1);
  const tips = await waitForTips(page, 2, 8000);
  await expect(tips.filter({ hasText: "동백나무" })).toHaveCount(1);
  await expect(tips.filter({ hasText: "수국" })).toHaveCount(1);
  await expect(page.locator("#app")).toHaveAttribute("data-state", "ready");

  // 수동 모드에서는 추가 요청이 나가지 않아야 한다.
  await page.waitForTimeout(1000);
  expect(requests.count).toBe(baseline + 1);
  await expect(btnAuto).toHaveAttribute("aria-pressed", "false");
});

test("tooltips are re-laid out inside the viewport after a resize", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const before = await tipPositions(page);
  const viewportBefore = await page.locator("#viewport").boundingBox();

  // 뷰 크기가 바뀌면 잘리는 영역과 분석 샘플 크기도 바뀌어 스캐너가 씬 변화로 보고 다시 인식한다.
  // 여기서는 app.js의 재배치만 검사하므로 자동 인식을 먼저 끈다.
  const btnAuto = page.locator("#btn-toggle-auto");
  await btnAuto.click();
  await expect(btnAuto).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => window.__gardenLens.scanner.isRunning())).toBe(false);

  // 720px 미만으로 유지한다 (그 이상이면 데스크톱 레이아웃으로 바뀐다).
  await page.setViewportSize({ width: 600, height: 700 });

  await expect.poll(async () => (await page.locator("#viewport").boundingBox()).width).not.toBe(viewportBefore.width);
  await expect.poll(() => tipPositions(page), { timeout: 5000 }).not.toEqual(before);

  const after = await tipPositions(page);
  expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
  expect(after.some((t, i) => t.left !== before[i].left || t.top !== before[i].top)).toBe(true);
  await expect(tips).toHaveCount(2);
  await expectTipsInsideViewport(page, tips);
  await expect(page.locator("#status")).toContainText("동백나무, 수국");
});

test("flat scene is judged blurry locally and sends no request", async ({ page }) => {
  await installFakeCamera(page, "flat");
  const requests = countIdentifyRequests(page);
  const t0 = Date.now();
  await gotoApp(page);

  const hint = page.locator("#hint");
  await expect(hint).toBeVisible({ timeout: 3000 });
  await expect(hint).toContainText("카메라를 잠시 고정");

  await page.waitForTimeout(Math.max(0, 3000 - (Date.now() - t0)));
  expect(requests.count).toBe(0);
  await expect(page.locator("#overlay .plant-tip")).toHaveCount(0);
});
