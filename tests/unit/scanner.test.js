// scanner.js 단위 테스트. 가짜 타이머와 시계를 주입해 루프를 결정적으로 돌린다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScanner } from "../../public/js/scanner.js";
import { hintFor } from "../../public/js/quality.js";

// 마이크로태스크와 identify 프로미스 체인이 정리될 때까지 한 매크로태스크 양보한다.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeClock() {
  let t = 0;
  let seq = 0;
  const timers = [];
  return {
    now: () => t,
    pending: () => timers.length,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.push({ id, at: t + Math.max(0, ms | 0), fn });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    // 만료 시각 순서로 타이머를 실행하며 ms만큼 시간을 흘린다.
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

// ImageData 모양의 샘플. v는 0..1 밝기 값이며 가짜 diff는 |va - vb|를 돌려준다.
function sample(v, verdict = "ok") {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  data.fill(Math.round(v * 255));
  return { data, width: 4, height: 4, v, verdict };
}

const OK_RESULT = { quality: "ok", message_ko: null, plants: [{ id: "p1", name_ko: "동백나무" }] };
// captureFrame이 돌려주는 crop 기록. 스캐너는 이 값을 그대로 identify에 넘겨야 한다.
const CROP = { sx: 100, sy: 0, sw: 440, sh: 480, videoW: 640, videoH: 480 };

function setup(overrides = {}) {
  const clock = makeClock();
  // scene: capture()가 돌려줄 현재 프레임. 테스트가 v/verdict를 바꾼다. crop이 null이면 프레임에 crop 키를 넣지 않는다.
  const scene = { v: 0.5, verdict: "ok", frame: true, crop: { ...CROP } };
  const calls = { identify: [], hints: [], results: [], errors: [], busy: [], sceneChanges: 0 };
  let identifyImpl = async () => ({ ...OK_RESULT });
  const scanner = createScanner({
    capture: () =>
      scene.frame
        ? {
            base64: "QUJD",
            width: 640,
            height: 480,
            imageData: sample(scene.v, scene.verdict),
            ...(scene.crop ? { crop: scene.crop } : {}),
          }
        : null,
    analyze: (img) => ({ luminance: img.v * 255, sharpness: 100, verdict: img.verdict }),
    diff: (a, b) => Math.abs(a.v - b.v),
    identify: (payload) => {
      calls.identify.push({ ...payload, at: clock.now() });
      return identifyImpl(payload);
    },
    onHint: (msg) => calls.hints.push(msg),
    onResult: (res) => calls.results.push(res),
    onError: (err) => calls.errors.push(err),
    onBusy: (b) => calls.busy.push(b),
    onSceneChange: () => {
      calls.sceneChanges++;
    },
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    now: clock.now,
    ...overrides,
  });
  return {
    clock,
    scene,
    calls,
    scanner,
    setIdentify(fn) {
      identifyImpl = fn;
    },
  };
}

test("start/stop/isRunning: 멱등하며 타이머를 정리한다", async () => {
  const { clock, scanner } = setup();
  assert.equal(scanner.isRunning(), false);
  scanner.start();
  scanner.start();
  assert.equal(scanner.isRunning(), true);
  assert.equal(clock.pending(), 1);
  scanner.stop();
  assert.equal(scanner.isRunning(), false);
  assert.equal(clock.pending(), 0);
  scanner.stop();
  assert.equal(clock.pending(), 0);
});

test("verdict가 too_dark이면 안내만 하고 요청하지 않는다", async () => {
  const { clock, scene, calls, scanner } = setup();
  scene.verdict = "too_dark";
  scanner.start();
  await clock.advance(3000);
  assert.equal(calls.identify.length, 0);
  assert.ok(calls.hints.length > 0);
  assert.ok(calls.hints.every((h) => h === hintFor("too_dark")));
  assert.equal(calls.busy.length, 0);
});

test("torchSupported 옵션에 따라 too_dark 문구가 달라진다", async () => {
  const { clock, scene, calls, scanner } = setup({ torchSupported: () => true });
  scene.verdict = "too_dark";
  scanner.start();
  await clock.advance(250);
  assert.equal(calls.hints[0], hintFor("too_dark", { torchSupported: true }));
});

test("capture가 null이면 샘플을 건너뛴다", async () => {
  const { clock, scene, calls, scanner } = setup();
  scene.frame = false;
  scanner.start();
  await clock.advance(2000);
  assert.equal(calls.identify.length, 0);
  assert.equal(calls.hints.length, 0);
});

test("안정된 뒤 요청하고, ok 결과가 있으면 씬이 바뀔 때까지 다시 요청하지 않는다", async () => {
  const { clock, calls, scanner } = setup();
  scanner.start();
  await clock.advance(250); // 첫 샘플: 비교 대상이 없어 요청하지 않는다
  assert.equal(calls.identify.length, 0);
  await clock.advance(250); // 두 번째 샘플: 안정
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.identify[0].at, 500);
  assert.deepEqual(
    {
      base64: calls.identify[0].base64,
      width: calls.identify[0].width,
      height: calls.identify[0].height,
      crop: calls.identify[0].crop,
    },
    { base64: "QUJD", width: 640, height: 480, crop: CROP }
  );
  assert.deepEqual(calls.busy, [true, false]);
  assert.equal(calls.results.length, 1);
  assert.equal(calls.results[0].quality, "ok");
  await clock.advance(10000);
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.errors.length, 0);
  // ok 상태에서는 안내를 해제한다.
  assert.ok(calls.hints.length > 0);
  assert.ok(calls.hints.every((h) => h === null));
});

test("씬이 바뀌면 결과를 버리고, 간격이 지난 뒤 안정되면 다시 요청한다", async () => {
  const { clock, scene, calls, scanner } = setup();
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.sceneChanges, 0);
  scene.v = 0.9; // 0.4 차이: sceneChangeDiff(0.18) 이상
  await clock.advance(250); // t=750: 씬 변화 감지, 불안정
  assert.equal(calls.sceneChanges, 1);
  assert.equal(calls.identify.length, 1);
  await clock.advance(2000); // t=2750: 안정이지만 아직 minIntervalMs 미만
  assert.equal(calls.identify.length, 1);
  await clock.advance(250); // t=3000 = 500 + 2500
  assert.equal(calls.identify.length, 2);
  assert.equal(calls.identify[1].at, 3000);
  assert.equal(calls.sceneChanges, 1);
});

test("요청 중에는 두 번째 요청을 보내지 않는다", async () => {
  const { clock, scene, calls, scanner, setIdentify } = setup();
  let resolveFirst;
  setIdentify(() => new Promise((resolve) => (resolveFirst = resolve)));
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  assert.deepEqual(calls.busy, [true]);
  scene.v = 0.95; // 씬이 바뀌어도 진행 중이면 보내지 않는다
  await clock.advance(6000);
  assert.equal(calls.identify.length, 1);
  resolveFirst({ ...OK_RESULT });
  await flush();
  assert.deepEqual(calls.busy, [true, false]);
  assert.equal(calls.results.length, 1);
  // 응답 뒤 루프는 정상적으로 이어진다. 결과 샘플은 요청 시점의 0.5이므로 씬을 되돌리면 재요청하지 않는다.
  scene.v = 0.5;
  await clock.advance(3000);
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.sceneChanges, 0);
  // 결과 샘플과 다른 씬이 되면 재요청한다.
  scene.v = 0.2;
  await clock.advance(3000);
  assert.equal(calls.sceneChanges, 1);
  assert.equal(calls.identify.length, 2);
});

test("scanNow는 간격과 안정 조건을 무시하고 즉시 요청한다", async () => {
  const { clock, calls, scanner } = setup();
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  await clock.advance(100); // t=600, 간격(2500) 미만
  scanner.scanNow();
  await flush();
  assert.equal(calls.identify.length, 2);
  assert.equal(calls.identify[1].at, 600);
  assert.equal(calls.results.length, 2);
});

test("프레임에 crop이 없으면 identify에 crop: null을 넘긴다", async () => {
  const { scene, calls, scanner } = setup();
  scene.crop = null;
  scanner.scanNow();
  await flush();
  assert.equal(calls.identify.length, 1);
  assert.ok("crop" in calls.identify[0], "crop 키는 항상 있어야 한다");
  assert.equal(calls.identify[0].crop, null);
  assert.equal(calls.identify[0].base64, "QUJD");
});

test("scanNow는 루프가 꺼져 있어도 동작하고, 너무 어두우면 안내만 한다", async () => {
  const { scene, calls, scanner } = setup();
  assert.equal(scanner.isRunning(), false);
  scanner.scanNow();
  await flush();
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.results.length, 1);
  scene.verdict = "too_dark";
  scanner.scanNow();
  await flush();
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.hints.at(-1), hintFor("too_dark"));
  // 흐린 프레임은 수동 스캔에서는 그대로 보낸다.
  scene.verdict = "blurry";
  scanner.scanNow();
  await flush();
  assert.equal(calls.identify.length, 2);
});

test("scanNow는 요청 중이면 무시한다", async () => {
  const { calls, scanner, setIdentify } = setup();
  let resolveFirst;
  setIdentify(() => new Promise((resolve) => (resolveFirst = resolve)));
  scanner.scanNow();
  scanner.scanNow();
  await flush();
  assert.equal(calls.identify.length, 1);
  resolveFirst({ ...OK_RESULT });
  await flush();
  assert.deepEqual(calls.busy, [true, false]);
});

test("identify 오류는 onError로 알리고 5초 동안 재요청하지 않는다", async () => {
  const { clock, calls, scanner, setIdentify } = setup();
  const boom = new Error("network");
  setIdentify(() => Promise.reject(boom));
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0], boom);
  assert.deepEqual(calls.busy, [true, false]);
  await clock.advance(4750); // t=5250 < 500 + 5000
  assert.equal(calls.identify.length, 1);
  await clock.advance(250); // t=5500
  assert.equal(calls.identify.length, 2);
});

test("서버 안내(ok가 아닌 응답)는 씬이 바뀌기 전까지 onHint(null)로 지워지지 않는다", async () => {
  const { clock, scene, calls, scanner, setIdentify } = setup();
  setIdentify(async () => ({ quality: "no_plant", message_ko: "식물이 없습니다.", plants: [] }));
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.results[0].quality, "no_plant");
  assert.equal(calls.hints.at(-1), "식물이 없습니다.");
  const before = calls.hints.length;
  await clock.advance(1000);
  assert.equal(calls.hints.length, before); // ok 샘플이어도 서버 안내는 유지된다
  scene.v = 0.9;
  await clock.advance(250);
  assert.equal(calls.hints.at(-1), null);
  assert.equal(calls.sceneChanges, 0); // ok 결과가 아니었으므로 onSceneChange는 부르지 않는다
});

test("서버 안내 뒤 같은 씬은 retryHoldMs가 지나면 자동으로 다시 시도한다", async () => {
  const { clock, calls, scanner, setIdentify } = setup();
  setIdentify(async () => ({ quality: "blurry", message_ko: "흔들립니다.", plants: [] }));
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  await clock.advance(4750); // t=5250 < 500 + 5000
  assert.equal(calls.identify.length, 1);
  await clock.advance(250); // t=5500
  assert.equal(calls.identify.length, 2);
});

test("로컬 안내가 서버 안내를 덮어쓰면 다시 ok가 되었을 때 안내를 해제한다", async () => {
  const { clock, scene, calls, scanner, setIdentify } = setup();
  setIdentify(async () => ({ quality: "no_plant", message_ko: "식물이 없습니다.", plants: [] }));
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.hints.at(-1), "식물이 없습니다.");
  scene.verdict = "blurry";
  await clock.advance(250);
  assert.equal(calls.hints.at(-1), hintFor("blurry"));
  scene.verdict = "ok";
  await clock.advance(250);
  assert.equal(calls.hints.at(-1), null);
});

test("로컬 안내가 잠깐 떠도 같은 씬이면 결과를 유지하고 재요청하지 않는다", async () => {
  const { clock, scene, calls, scanner } = setup();
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  scene.verdict = "blurry";
  await clock.advance(250);
  assert.equal(calls.hints.at(-1), hintFor("blurry"));
  scene.verdict = "ok";
  await clock.advance(2500); // t=3250: 간격도 지났고 안정 상태지만 씬이 같다
  assert.equal(calls.identify.length, 1);
  assert.equal(calls.hints.at(-1), null);
  assert.equal(calls.sceneChanges, 0);
});

test("로컬 안내 뒤 씬이 바뀌어 있으면 결과를 버리고 재요청한다", async () => {
  const { clock, scene, calls, scanner } = setup();
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  scene.verdict = "blurry";
  await clock.advance(250);
  scene.v = 0.9; // 흔들리는 동안 다른 식물로 이동했다
  scene.verdict = "ok";
  await clock.advance(2500);
  assert.equal(calls.sceneChanges, 1);
  assert.equal(calls.identify.length, 2);
});

test("같은 씬에서 비-ok 응답이 반복되면 재시도 간격이 두 배씩 늘어난다 (최대 60초)", async () => {
  const { clock, scene, calls, scanner, setIdentify } = setup();
  setIdentify(async () => ({ quality: "no_plant", message_ko: "식물이 없습니다.", plants: [] }));
  scanner.start();
  await clock.advance(500); // 1번째 요청 t=500
  assert.equal(calls.identify.length, 1);
  await clock.advance(5000); // t=5500: 5초 대기 후 2번째
  assert.equal(calls.identify.length, 2);
  await clock.advance(9750); // t=15250 < 5500 + 10000
  assert.equal(calls.identify.length, 2);
  await clock.advance(250); // t=15500: 10초 대기 후 3번째
  assert.equal(calls.identify.length, 3);
  await clock.advance(20000); // t=35500: 20초 대기 후 4번째
  assert.equal(calls.identify.length, 4);
  scene.v = 0.9; // 씬이 바뀌면 대기 시간이 초기화된다
  await clock.advance(2500); // 간격(2.5초)만 지나면 바로 5번째
  assert.equal(calls.identify.length, 5);
  await clock.advance(5000); // 다시 5초 대기 후 6번째
  assert.equal(calls.identify.length, 6);
});

test("stop() 뒤에 도착한 응답은 버리되 바쁨 표시는 해제한다", async () => {
  const { clock, calls, scanner, setIdentify } = setup();
  let resolveFirst;
  setIdentify(() => new Promise((resolve) => (resolveFirst = resolve)));
  scanner.start();
  await clock.advance(500);
  assert.equal(calls.identify.length, 1);
  scanner.stop();
  resolveFirst({ ...OK_RESULT });
  await flush();
  assert.equal(calls.results.length, 0);
  assert.deepEqual(calls.busy, [true, false]);
});

test("stop() 뒤에 도착한 오류도 버린다", async () => {
  const { clock, calls, scanner, setIdentify } = setup();
  let rejectFirst;
  setIdentify(() => new Promise((_resolve, reject) => (rejectFirst = reject)));
  scanner.start();
  await clock.advance(500);
  scanner.stop();
  rejectFirst(new Error("late"));
  await flush();
  assert.equal(calls.errors.length, 0);
  assert.deepEqual(calls.busy, [true, false]);
});

test("불안정한 프레임에서는 요청하지 않는다", async () => {
  const { clock, scene, calls, scanner } = setup();
  scanner.start();
  let v = 0;
  for (let i = 0; i < 12; i++) {
    v += 0.1; // 매 샘플 0.1 차이: stableDiff(0.06) 초과
    scene.v = v % 1;
    await clock.advance(250);
  }
  assert.equal(calls.identify.length, 0);
});

test("capture가 throw해도 루프는 계속 돌며 onError로 알린다", async () => {
  const { clock, calls, scanner } = setup({
    capture: () => {
      throw new Error("canvas");
    },
  });
  scanner.start();
  await clock.advance(500);
  assert.ok(calls.errors.length >= 1);
  assert.equal(scanner.isRunning(), true);
  assert.equal(clock.pending(), 1);
});
