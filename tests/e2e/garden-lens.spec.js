// Garden Lens 전체 흐름 E2E. mock 제공자(동백나무, 수국)와 캔버스 기반 가짜 카메라를 쓴다.
import { test, expect } from "@playwright/test";
import {
  installFakeCamera,
  countIdentifyRequests,
  gotoApp,
  waitForTips,
  tipPositions,
  expectTipsInsideViewport,
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
    const tipEls = Array.from(overlay.querySelectorAll(".plant-tip"));
    const placements = tipEls.map((tip) => {
      const plant = result.plants.find((p) => p.id === tip.dataset.plantId);
      const rect = m.mapBBox(plant.bbox, geometry);
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
