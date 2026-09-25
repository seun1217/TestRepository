// 2단계 인식(툴팁 터치 -> POST /api/describe) E2E. 시트의 불러오는 중, 오류와 다시 시도, 늦은 응답 무시, 스캐너 일시 정지를 검사한다.
// identify와 describe는 Playwright 라우트로 가로채므로 서버의 mock describe 구현 시점에 의존하지 않는다 (마지막 테스트만 실제 mock 경로).
import { test, expect } from "@playwright/test";
import { installFakeCamera, gotoApp, waitForTips, countIdentifyRequests } from "./helpers.js";

// providers/mock.js의 두 식물. 1단계에서는 detail_ko를 비워 보낸다.
const LAZY_PLANTS = [
  {
    id: "p1",
    name_ko: "동백나무",
    name_sci: "Camellia japonica",
    name_en: "Japanese camellia",
    family_ko: "차나무과",
    confidence: 0.91,
    bbox: { x: 0.1, y: 0.15, w: 0.35, h: 0.5 },
    summary_ko: "겨울에서 이른 봄에 붉은 꽃이 피는 상록 활엽수입니다.",
    detail_ko: "",
    tags: ["상록수", "겨울꽃", "남부수종"],
  },
  {
    id: "p2",
    name_ko: "수국",
    name_sci: "Hydrangea macrophylla",
    name_en: "Bigleaf hydrangea",
    family_ko: "수국과",
    confidence: 0.78,
    bbox: { x: 0.55, y: 0.3, w: 0.35, h: 0.45 },
    summary_ko: "초여름에 공 모양의 큰 꽃송이가 피는 낙엽 관목입니다.",
    detail_ko: "",
    tags: ["낙엽관목", "여름꽃"],
  },
];

const LOADING_TEXT = "상세 설명을 불러오는 중입니다";
const DETAIL_TEXT = "첫 문단입니다.\n\n둘째 문단입니다.";
const P1_TEXT = "동백나무 늦은 설명입니다.";
const P2_TEXT = "수국 빠른 설명입니다.";
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 };

const json = (status, body) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const identifyBody = () => ({
  quality: "ok",
  message_ko: null,
  plants: LAZY_PLANTS.map((p) => ({ ...p, bbox: { ...p.bbox }, tags: [...p.tags] })),
  model: "mock",
  usage: { ...ZERO_USAGE },
});

const describeBody = (detail_ko) => ({ detail_ko, model: "mock", usage: { ...ZERO_USAGE } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 지연 뒤 응답한다. 테스트가 먼저 끝나 페이지가 닫혔으면 fulfill 오류는 무시한다.
async function fulfillLater(route, delayMs, response) {
  await sleep(delayMs);
  try {
    await route.fulfill(response);
  } catch {
    // 페이지가 이미 닫혔다.
  }
}

// 1단계 응답을 상세 없이 돌려준다.
async function routeLazyIdentify(page) {
  await page.route("**/api/identify", (route) => route.fulfill(json(200, identifyBody())));
}

// POST /api/describe 요청 수와 본문을 기록한다. page.goto 전에 호출해야 한다.
function countDescribeRequests(page) {
  const log = { count: 0, bodies: [] };
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    let pathname = "";
    try {
      pathname = new URL(req.url()).pathname;
    } catch {
      return;
    }
    if (pathname !== "/api/describe") return;
    log.count += 1;
    try {
      log.bodies.push(req.postDataJSON());
    } catch {
      log.bodies.push(null);
    }
  });
  return log;
}

const detailOf = (page) => page.locator("#sheet [data-field=detail_ko]");
const paragraphsOf = (page) => page.locator("#sheet [data-field=detail_ko] > p:not(.sheet-loading):not(.sheet-error)");

async function closeSheet(page) {
  await page.locator("#sheet .sheet-close").click();
  await expect(page.locator("#sheet")).toBeHidden();
}

test("lazy detail: tapping a tip shows loading, then the describe paragraphs, and reopening uses the cache", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await routeLazyIdentify(page);
  await page.route("**/api/describe", (route) => fulfillLater(route, 400, json(200, describeBody(DETAIL_TEXT))));
  const describes = countDescribeRequests(page);
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const camelliaTip = tips.filter({ hasText: "동백나무" });
  const sheet = page.locator("#sheet");
  const detail = detailOf(page);

  await camelliaTip.click();
  await expect(sheet).toBeVisible();
  await expect(page.locator("#sheet-title")).toHaveText("동백나무");
  await expect(detail.locator("p.sheet-loading")).toHaveText(LOADING_TEXT);
  await expect(detail).toHaveAttribute("aria-busy", "true");

  await expect(paragraphsOf(page)).toHaveText(["첫 문단입니다.", "둘째 문단입니다."], { timeout: 5000 });
  await expect(detail.locator(".sheet-loading")).toHaveCount(0);
  await expect(detail).not.toHaveAttribute("aria-busy", "true");

  expect(describes.count).toBe(1);
  const sent = describes.bodies[0];
  expect(sent.plant.name_ko).toBe("동백나무");
  expect(sent.plant.id).toBe("p1");
  expect(sent.plant.name_sci).toBe("Camellia japonica");
  expect(sent.plant.bbox).toEqual(LAZY_PLANTS[0].bbox);
  expect(typeof sent.image).toBe("string");
  expect(sent.image.length).toBeGreaterThan(0);
  expect(sent.width).toBeGreaterThan(0);
  expect(sent.height).toBeGreaterThan(0);
  expect(sent.lang).toBe("ko");
  // 성공한 설명은 결과의 식물 객체에 캐시된다.
  expect(await page.evaluate(() => window.__gardenLens.lastResult.plants[0].detail_ko)).toBe(DETAIL_TEXT);

  // 닫았다가 같은 툴팁을 다시 열면 캐시를 쓰고 요청은 다시 보내지 않는다.
  await closeSheet(page);
  await camelliaTip.click();
  await expect(sheet).toBeVisible();
  await expect(paragraphsOf(page)).toHaveText(["첫 문단입니다.", "둘째 문단입니다."]);
  await expect(detail.locator(".sheet-loading")).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(describes.count).toBe(1);
});

test("describe error shows the message and the retry button, and retry loads the paragraphs", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await routeLazyIdentify(page);
  let calls = 0;
  await page.route("**/api/describe", (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill(json(502, { error: { code: "upstream_error", message_ko: "테스트 설명 오류" } }));
    }
    return route.fulfill(json(200, describeBody(DETAIL_TEXT)));
  });
  const describes = countDescribeRequests(page);
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const detail = detailOf(page);

  await tips.filter({ hasText: "동백나무" }).click();
  const error = detail.locator("p.sheet-error");
  await expect(error).toContainText("테스트 설명 오류");
  await expect(detail).not.toHaveAttribute("aria-busy", "true");
  const retry = detail.locator("button.sheet-retry");
  await expect(retry).toHaveText("다시 시도");
  await expect(retry).toHaveAttribute("type", "button");
  expect(describes.count).toBe(1);
  // 실패한 설명은 캐시되지 않는다.
  expect(await page.evaluate(() => window.__gardenLens.lastResult.plants[0].detail_ko)).toBe("");

  await retry.click();
  await expect(paragraphsOf(page)).toHaveText(["첫 문단입니다.", "둘째 문단입니다."], { timeout: 5000 });
  await expect(detail.locator(".sheet-error")).toHaveCount(0);
  await expect(detail.locator(".sheet-retry")).toHaveCount(0);
  expect(describes.count).toBe(2);
  expect(describes.bodies[1].plant.name_ko).toBe("동백나무");
});

test("a late describe response for a previous plant never overwrites the plant now shown", async ({ page }) => {
  await installFakeCamera(page, "bright");
  await routeLazyIdentify(page);
  await page.route("**/api/describe", (route) => {
    const plant = route.request().postDataJSON()?.plant;
    if (plant?.id === "p1") return fulfillLater(route, 1500, json(200, describeBody(P1_TEXT)));
    return route.fulfill(json(200, describeBody(P2_TEXT)));
  });
  const describes = countDescribeRequests(page);
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const sheet = page.locator("#sheet");
  const detail = detailOf(page);

  await tips.filter({ hasText: "동백나무" }).click();
  await expect(detail.locator("p.sheet-loading")).toHaveText(LOADING_TEXT);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await tips.filter({ hasText: "수국" }).click();
  await expect(page.locator("#sheet-title")).toHaveText("수국");
  await expect(paragraphsOf(page)).toHaveText([P2_TEXT]);

  // p1의 늦은 응답이 도착하는 2초 동안 시트는 계속 수국의 설명만 보여야 한다.
  const t0 = Date.now();
  while (Date.now() - t0 < 2000) {
    await expect(page.locator("#sheet-title")).toHaveText("수국");
    const text = await detail.textContent();
    expect(text).toContain(P2_TEXT);
    expect(text).not.toContain(P1_TEXT);
    await page.waitForTimeout(100);
  }
  // 늦은 응답은 실제로 도착해 캐시에는 들어갔다 (무시된 것이지 안 온 것이 아니다).
  expect(describes.count).toBe(2);
  expect(await page.evaluate(() => window.__gardenLens.lastResult.plants.map((p) => p.detail_ko))).toEqual([P1_TEXT, P2_TEXT]);
  await expect(paragraphsOf(page)).toHaveText([P2_TEXT]);
});

test("the scanner pauses while the sheet is open and resumes when it closes", async ({ page }) => {
  await installFakeCamera(page, "bright");
  const requests = countIdentifyRequests(page);
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const sheet = page.locator("#sheet");
  const isRunning = () => page.evaluate(() => window.__gardenLens.scanner.isRunning());

  await expect.poll(isRunning).toBe(true);
  await tips.filter({ hasText: "동백나무" }).click();
  await expect(sheet).toBeVisible();
  // mock은 상세를 미리 채워 주므로 바로 문단이 보인다.
  expect(await paragraphsOf(page).count()).toBeGreaterThanOrEqual(2);
  await expect.poll(isRunning).toBe(false);
  const baseline = requests.count;

  // 뷰 크기를 바꾸면 스캐너가 씬 변화로 보고 다시 인식하려 하지만, 시트가 열린 동안에는 멈춰 있어야 한다.
  await page.setViewportSize({ width: 600, height: 700 });
  await page.waitForTimeout(3500);
  expect(requests.count).toBe(baseline);
  expect(await isRunning()).toBe(false);
  await expect(sheet).toBeVisible();

  await page.locator("#sheet .sheet-close").click();
  await expect(sheet).toBeHidden();
  await expect.poll(isRunning).toBe(true);
  // 다시 돈 스캐너가 바뀐 씬을 새로 인식한다.
  await expect.poll(() => requests.count, { timeout: 8000 }).toBeGreaterThan(baseline);
  await waitForTips(page, 2, 8000);

  // 이미 닫힌 시트에 Escape를 눌러도 스캐너 상태는 그대로다.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  expect(await isRunning()).toBe(true);
});

test("real mock route: debug lazy identify leaves detail empty and /api/describe fills it", async ({ page }) => {
  await installFakeCamera(page, "bright");
  // 요청 본문에 debug: "lazy"를 넣어 실제 mock 서버가 상세 없는 1단계 응답을 돌려주게 한다.
  await page.route("**/api/identify", (route) => {
    const body = route.request().postDataJSON() || {};
    return route.continue({ postData: JSON.stringify({ ...body, debug: "lazy" }) });
  });
  const describes = countDescribeRequests(page);
  await gotoApp(page);
  const tips = await waitForTips(page, 2, 8000);
  const detail = detailOf(page);

  expect(await page.evaluate(() => window.__gardenLens.lastResult.plants.map((p) => p.detail_ko))).toEqual(["", ""]);
  await tips.filter({ hasText: "수국" }).click();
  await expect(page.locator("#sheet-title")).toHaveText("수국");
  await expect(paragraphsOf(page)).toHaveCount(2, { timeout: 8000 });
  await expect(paragraphsOf(page).first()).toContainText("장식꽃");
  await expect(detail.locator(".sheet-loading")).toHaveCount(0);
  expect(describes.count).toBe(1);
  expect(describes.bodies[0].plant.name_ko).toBe("수국");
});
