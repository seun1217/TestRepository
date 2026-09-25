// server.js 계약 테스트 (docs/CONTRACT.md 2절). mock 제공자로 실제 API 호출 없이 검증한다.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.IDENTIFY_PROVIDER = "mock";
delete process.env.RATE_LIMIT_PER_MIN;
delete process.env.TRUST_PROXY;
delete process.env.CLAUDE_MODEL;

// 기본 인스턴스 (분당 20회, 프록시 신뢰 안 함).
const { default: app, normalizeResponse } = await import("../../server.js");

// 환경 변수는 모듈 로드 시점에 읽히므로, 쿼리 문자열로 캐시를 우회해 설정이 다른 인스턴스를 따로 만든다.
process.env.RATE_LIMIT_PER_MIN = "3";
const { default: limitedApp } = await import("../../server.js?instance=limit3");
process.env.TRUST_PROXY = "1";
const { default: proxiedApp } = await import("../../server.js?instance=limit3-proxy");
delete process.env.RATE_LIMIT_PER_MIN;
delete process.env.TRUST_PROXY;

const JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==";
const KOREAN = /[가-힣]/;

function listen(instance) {
  return new Promise((resolve) => {
    const server = instance.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postIdentify(base, body, headers = {}) {
  const res = await fetch(`${base}/api/identify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

const goodBody = { image: JPEG_B64, width: 1024, height: 768, lang: "ko" };

describe("server: health", () => {
  let server;
  let base;
  before(async () => ({ server, base } = await listen(app)));
  after(() => close(server));

  test("GET /api/health returns ok, provider and model with no-store", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.provider, "mock");
    assert.equal(json.model, "claude-opus-5");
  });
});

describe("server: POST /api/identify", () => {
  let server;
  let base;
  before(async () => ({ server, base } = await listen(app)));
  after(() => close(server));

  test("happy path: two plants, ids p1/p2, sorted by confidence, numeric bbox", async () => {
    const { res, json } = await postIdentify(base, goodBody);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(json.quality, "ok");
    assert.equal(json.message_ko, null);
    assert.equal(json.plants.length, 2);
    assert.deepEqual(json.plants.map((p) => p.id), ["p1", "p2"]);
    assert.equal(json.plants[0].name_ko, "동백나무");
    assert.equal(json.plants[1].name_ko, "수국");
    assert.ok(json.plants[0].confidence >= json.plants[1].confidence);
    for (const p of json.plants) {
      for (const k of ["x", "y", "w", "h"]) {
        assert.equal(typeof p.bbox[k], "number");
        assert.ok(p.bbox[k] >= 0 && p.bbox[k] <= 1);
      }
      assert.ok(Array.isArray(p.tags));
    }
    assert.equal(json.model, "mock");
    assert.deepEqual(json.usage, { input_tokens: 0, output_tokens: 0 });
  });

  test("debug too_dark returns that quality with a Korean message and no plants", async () => {
    const { res, json } = await postIdentify(base, { ...goodBody, debug: "too_dark" });
    assert.equal(res.status, 200);
    assert.equal(json.quality, "too_dark");
    assert.deepEqual(json.plants, []);
    assert.match(json.message_ko, /^너무 어둡습니다/);
  });

  test("data URL prefix is accepted", async () => {
    const { res, json } = await postIdentify(base, { ...goodBody, image: `data:image/jpeg;base64,${JPEG_B64}` });
    assert.equal(res.status, 200);
    assert.equal(json.quality, "ok");
    assert.equal(json.plants.length, 2);
  });

  test("data URL with unsupported media type -> 400", async () => {
    const { res, json } = await postIdentify(base, { ...goodBody, image: `data:image/bmp;base64,${JPEG_B64}` });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "bad_request");
    assert.match(json.error.message_ko, KOREAN);
  });

  test("empty image -> 400 with Korean message", async () => {
    const { res, json } = await postIdentify(base, { ...goodBody, image: "" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(json.error.code, "bad_request");
    assert.equal(json.error.message_ko, "이미지가 비어 있습니다.");
  });

  test("non-base64 image -> 400 with Korean message", async () => {
    const { res, json } = await postIdentify(base, { ...goodBody, image: "not base64 at all!!" });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "bad_request");
    assert.match(json.error.message_ko, KOREAN);
  });

  test("missing width -> 400 with Korean message", async () => {
    const { width, ...noWidth } = goodBody;
    void width;
    const { res, json } = await postIdentify(base, noWidth);
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "bad_request");
    assert.equal(json.error.message_ko, "이미지 크기 정보가 필요합니다.");
  });

  test("malformed JSON body -> 400 with Korean message and no-store", async () => {
    const { res, json } = await postIdentify(base, "{ not json");
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(json.error.code, "bad_request");
    assert.match(json.error.message_ko, KOREAN);
  });
});

describe("normalizeResponse", () => {
  const plant = (over = {}) => ({
    name_ko: "동백나무",
    name_sci: "Camellia japonica",
    name_en: "Japanese camellia",
    family_ko: "차나무과",
    confidence: 0.9,
    bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
    summary_ko: "요약입니다.",
    detail_ko: "설명입니다.",
    tags: ["상록수"],
    ...over,
  });

  test("clamps bbox into 0..1 and trims w/h to the image edge", () => {
    const out = normalizeResponse({ quality: "ok", plants: [plant({ bbox: { x: -0.2, y: 0.5, w: 1.5, h: 0.9 } })] }, "m");
    assert.equal(out.quality, "ok");
    assert.deepEqual(out.plants[0].bbox, { x: 0, y: 0.5, w: 1, h: 0.5 });
    assert.equal(out.plants[0].confidence, 0.9);
  });

  test("filters confidence < 0.35 and returns too_far when everything is filtered", () => {
    const out = normalizeResponse({ quality: "ok", plants: [plant({ confidence: 0.2 }), plant({ confidence: 0.349 })] }, "m");
    assert.equal(out.quality, "too_far");
    assert.deepEqual(out.plants, []);
    assert.match(out.message_ko, /더 가까이/);
  });

  test("keeps plants at or above 0.35", () => {
    const out = normalizeResponse({ quality: "ok", plants: [plant({ confidence: 0.35 }), plant({ confidence: 0.2 })] }, "m");
    assert.equal(out.quality, "ok");
    assert.equal(out.plants.length, 1);
  });

  test("returns no_plant when plants is empty", () => {
    const out = normalizeResponse({ quality: "ok", plants: [] }, "m");
    assert.equal(out.quality, "no_plant");
    assert.deepEqual(out.plants, []);
    assert.match(out.message_ko, KOREAN);
  });

  test("keeps at most 6, sorted by confidence, and reassigns ids", () => {
    const raw = Array.from({ length: 8 }, (_, i) => plant({ id: `weird-${i}`, confidence: 0.4 + i * 0.05 }));
    const out = normalizeResponse({ quality: "ok", plants: raw }, "m");
    assert.equal(out.plants.length, 6);
    assert.deepEqual(out.plants.map((p) => p.id), ["p1", "p2", "p3", "p4", "p5", "p6"]);
    for (let i = 1; i < out.plants.length; i += 1) {
      assert.ok(out.plants[i - 1].confidence >= out.plants[i].confidence);
    }
    assert.ok(Math.abs(out.plants[0].confidence - 0.75) < 1e-9);
  });

  test("non-ok quality passes through with message, and unknown quality becomes no_plant", () => {
    const dark = normalizeResponse({ quality: "too_dark", message_ko: "어둡습니다.", plants: [plant()] }, "m");
    assert.equal(dark.quality, "too_dark");
    assert.equal(dark.message_ko, "어둡습니다.");
    assert.deepEqual(dark.plants, []);
    const odd = normalizeResponse({ quality: "weird" }, "m");
    assert.equal(odd.quality, "no_plant");
    assert.match(odd.message_ko, KOREAN);
  });

  test("fills model fallback and zero usage when the provider gives none", () => {
    const out = normalizeResponse({ quality: "ok", plants: [plant()] }, "fallback-model");
    assert.equal(out.model, "fallback-model");
    assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
    assert.equal(out.plants[0].id, "p1");
  });
});

describe("rate limit (RATE_LIMIT_PER_MIN=3, TRUST_PROXY unset)", () => {
  let server;
  let base;
  let defaultServer;
  let defaultBase;
  before(async () => {
    ({ server, base } = await listen(limitedApp));
    ({ server: defaultServer, base: defaultBase } = await listen(app));
  });
  after(async () => {
    await close(server);
    await close(defaultServer);
  });

  test("4th request in the window -> 429 rate_limited; X-Forwarded-For is ignored without TRUST_PROXY", async () => {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const { res } = await postIdentify(base, goodBody, { "X-Forwarded-For": `198.51.100.${i + 1}` });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200]);
    const { res, json } = await postIdentify(base, goodBody, { "X-Forwarded-For": "198.51.100.99" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.equal(json.error.code, "rate_limited");
    assert.match(json.error.message_ko, KOREAN);
    assert.match(json.error.message_ko, /주세요\.$/);

    // 다른 인스턴스(기본 설정)의 버킷은 영향을 받지 않는다.
    const other = await postIdentify(defaultBase, goodBody);
    assert.equal(other.res.status, 200);
  });
});

describe("rate limit with TRUST_PROXY=1", () => {
  let server;
  let base;
  before(async () => ({ server, base } = await listen(proxiedApp)));
  after(() => close(server));

  test("buckets are keyed by the forwarded client IP", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { res } = await postIdentify(base, goodBody, { "X-Forwarded-For": "203.0.113.10" });
      assert.equal(res.status, 200);
    }
    const blocked = await postIdentify(base, goodBody, { "X-Forwarded-For": "203.0.113.10" });
    assert.equal(blocked.res.status, 429);
    assert.equal(blocked.json.error.code, "rate_limited");

    const otherClient = await postIdentify(base, goodBody, { "X-Forwarded-For": "203.0.113.11" });
    assert.equal(otherClient.res.status, 200);
  });
});
