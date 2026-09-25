// 자동 스캔 루프. docs/CONTRACT.md 4절 scanner.js.
// DOM을 건드리지 않고 타이머만 쓰므로, 타이머와 시계를 주입하면 Node에서도 테스트할 수 있다.
import { hintFor } from "./quality.js";

export function createScanner({
  capture,
  analyze,
  diff,
  identify,
  onHint,
  onResult,
  onError,
  onBusy,
  // 계약 외 추가 옵션 (모두 선택).
  onSceneChange, // () => void. 씬이 바뀌어 현재 결과를 버릴 때 호출. 앱은 여기서 오버레이를 지운다.
  torchSupported = false, // boolean 또는 () => boolean. too_dark 안내 문구 선택에 쓴다.
  minIntervalMs = 2500,
  stableDiff = 0.06,
  sceneChangeDiff = 0.18,
  sampleIntervalMs = 250,
  errorBackoffMs = 5000, // identify 오류 뒤 자동 재요청까지 기다리는 시간
  retryHoldMs = 5000, // 서버가 ok가 아닌 품질을 답한 뒤, 같은 씬을 자동 재요청하기까지 기다리는 시간
  retryHoldMaxMs = 60000, // 같은 씬에서 비-ok 응답이 반복되면 대기 시간을 두 배씩 늘리되 이 값을 넘지 않는다
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  now = () => Date.now(),
} = {}) {
  let running = false;
  let timer = null;
  let busy = false;
  let generation = 0; // stop()마다 증가. 이전 세대의 응답은 버린다.
  let lastRequestAt = -Infinity;
  let backoffUntil = -Infinity;
  let retryAt = -Infinity;
  let retryStreak = 0; // 같은 씬에서 연속으로 받은 비-ok 응답 수 (씬이 바뀌면 0)
  let prevSample = null; // 직전 샘플 (안정 판정용)
  let hasResult = false; // ok 결과가 살아 있는지
  let resultSample = null; // 마지막 응답을 만든 샘플 (씬 변화 판정 기준)
  let serverHint = false; // 서버 안내 문구가 표시 중인지

  const call = (fn, ...args) => {
    if (typeof fn === "function") fn(...args);
  };
  const torchOn = () => (typeof torchSupported === "function" ? !!torchSupported() : !!torchSupported);
  const localHint = (verdict) => hintFor(verdict, { torchSupported: torchOn() });

  // 로컬 품질 안내를 띄운다. 현재 결과는 버리지 않는다: 잠깐 흔들리거나 어두워졌다가
  // 같은 씬으로 돌아오면 툴팁을 그대로 쓰고, 씬이 바뀌었으면 ok 샘플에서 씬 변화로 잡힌다.
  function showLocalHint(verdict) {
    serverHint = false;
    call(onHint, localHint(verdict));
  }

  async function request(frame, sample) {
    const gen = generation;
    busy = true;
    lastRequestAt = now();
    serverHint = false;
    call(onBusy, true);
    try {
      const res = await identify({ base64: frame.base64, width: frame.width, height: frame.height, crop: frame.crop ?? null });
      if (gen !== generation) return;
      resultSample = sample;
      if (res && res.quality === "ok") {
        hasResult = true;
        retryStreak = 0;
      } else {
        // 서버 안내는 결과로 치지 않는다. 잠시 기다린 뒤 같은 씬이라도 다시 시도하되,
        // 같은 씬에서 반복되면 대기 시간을 두 배씩 늘려 불필요한 호출을 줄인다.
        hasResult = false;
        retryStreak += 1;
        retryAt = now() + Math.min(retryHoldMaxMs, retryHoldMs * 2 ** (retryStreak - 1));
        const msg = res?.message_ko || localHint(res?.quality);
        serverHint = Boolean(msg);
        if (msg) call(onHint, msg);
      }
      call(onResult, res);
    } catch (err) {
      if (gen !== generation) return;
      hasResult = false;
      resultSample = null;
      backoffUntil = now() + errorBackoffMs;
      call(onError, err);
    } finally {
      // stop() 뒤에 응답이 와도 바쁨 표시는 반드시 해제한다.
      busy = false;
      call(onBusy, false);
    }
  }

  function step() {
    const frame = capture();
    if (!frame || !frame.imageData) return;
    const sample = frame.imageData;
    const prev = prevSample;
    prevSample = sample;

    const verdict = analyze(sample)?.verdict;
    if (verdict !== "ok") {
      showLocalHint(verdict);
      return;
    }

    // 씬 변화: 마지막 응답 시점 샘플과 많이 다르면 결과와 서버 안내를 무효화한다.
    let droppedResult = false;
    if (resultSample && diff(resultSample, sample) >= sceneChangeDiff) {
      droppedResult = hasResult;
      hasResult = false;
      resultSample = null;
      serverHint = false;
      retryAt = -Infinity;
      retryStreak = 0;
    }
    if (!serverHint) call(onHint, null);
    if (droppedResult) call(onSceneChange);

    if (hasResult || busy) return;
    if (!prev || diff(prev, sample) > stableDiff) return;
    const t = now();
    if (t < backoffUntil || t < retryAt) return;
    if (t - lastRequestAt < minIntervalMs) return;
    request(frame, sample);
  }

  function tick() {
    timer = null;
    try {
      step();
    } catch (err) {
      backoffUntil = now() + errorBackoffMs;
      call(onError, err);
    } finally {
      if (running) schedule();
    }
  }

  function schedule() {
    if (timer != null) return;
    timer = setTimeoutFn(tick, sampleIntervalMs);
  }

  function start() {
    if (running) return;
    running = true;
    prevSample = null;
    schedule();
  }

  function stop() {
    running = false;
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    generation++;
  }

  // 간격, 안정, 대기 조건을 무시하고 즉시 한 번 요청한다. 너무 어두우면 안내만 하고 보내지 않는다.
  function scanNow() {
    if (busy) return;
    const frame = capture();
    if (!frame || !frame.imageData) return;
    const sample = frame.imageData;
    prevSample = sample;
    const verdict = analyze(sample)?.verdict;
    if (verdict === "too_dark") {
      showLocalHint("too_dark");
      return;
    }
    serverHint = false;
    call(onHint, null);
    request(frame, sample);
  }

  function isRunning() {
    return running;
  }

  return { start, stop, scanNow, isRunning };
}
