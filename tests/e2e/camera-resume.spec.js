// 화면 잠금이나 앱 전환 뒤 카메라 트랙이 끊겼을 때 앱이 카메라를 다시 열고 인식을 재개하는지 검증한다.
import { test, expect } from "@playwright/test";
import { installFakeCamera, gotoApp, waitForTips, countIdentifyRequests } from "./helpers.js";

test("an ended camera track is reopened on pageshow and identification resumes", async ({ page }) => {
  await installFakeCamera(page, "bright");
  const counter = countIdentifyRequests(page);
  await gotoApp(page);
  await waitForTips(page, 2, 8000);
  const before = counter.count;

  // 트랙을 끊고(잠금 화면과 같은 상황) bfcache 복귀 이벤트를 흉내 낸다.
  await page.evaluate(() => {
    window.__gardenLens.track.stop();
    window.dispatchEvent(new Event("pageshow"));
  });

  await expect
    .poll(() => page.evaluate(() => window.__gardenLens.track && window.__gardenLens.track.readyState), { timeout: 5000 })
    .toBe("live");
  await expect.poll(() => page.evaluate(() => window.__gardenLens.scanner.isRunning()), { timeout: 5000 }).toBe(true);
  // 새 스트림 위에서 다시 인식이 일어난다 (이전 결과는 복구 시 지워진다).
  await expect.poll(() => counter.count, { timeout: 8000 }).toBeGreaterThan(before);
  await waitForTips(page, 2, 8000);
});

test("a hidden then visible tab with a live track just restarts the scanner without reopening the camera", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await gotoApp(page);
  await waitForTips(page, 2, 8000);
  const streamId = await page.evaluate(() => window.__gardenLens.stream.id);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.__gardenLens.scanner.isRunning())).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.__gardenLens.scanner.isRunning()), { timeout: 5000 }).toBe(true);
  expect(await page.evaluate(() => window.__gardenLens.stream.id)).toBe(streamId);
});
