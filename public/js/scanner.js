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
  torchOn = false, // boolean 또는 () => boolean. 플래시가 켜져 있으면 too_dark 문구를 바꾼다.
  blurGraceMs = 4000, // 정지 화면이 계속 "흐림"으로 판정되면(질감이 적은 장면) 이 시간 뒤에는 서버에 맡긴다
  minIntervalMs = 2500,
  stableDiff = 0.06,
  sceneChangeDiff = 0.18,
  sampleIntervalMs = 250,
  errorBackoffMs = 5000, // identify 오류 뒤 자동 재요청까지 기다리는 시간 (반복되면 두 배씩, 최대 errorBackoffMaxMs)
  errorBackoffMaxMs = 60000,
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
  let errorStreak = 0; // 연속 오류 수 (성공하면 0)
  let lastServerMsg = null; // 재시도 대기 중 다시 보여줄 서버 안내
  let blurrySince = -Infinity; // 연속 흐림 판정이 시작된 시각
  let prevSample = null; // 직전 샘플 (안정 판정용)
  let hasResult = false; // ok 결과가 살아 있는지
  let resultSample = null; // 마지막 응답을 만든 샘플 (씬 변화 판정 기준)
  let serverHint = false; // 서버 안내 문구가 표시 중인지

  const call = (fn, ...args) => {
    if (typeof fn === "function") fn(...args);
  };
  const flag = (v) => (typeof v === "function" ? !!v() : !!v);
  const localHint = (verdict) => hintFor(verdict, { torchSupported: flag(torchSupported), torchOn: flag(torchOn) });

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
      // stop() 뒤에 도착해도 버리지 않는다: 이미 과금된 호출이므로 결과는 전달하고, 루프만 멈춘 상태를 유지한다.
      errorStreak = 0;
      resultSample = sample;
      if (res && res.quality === "ok") {
        hasResult = true;
        retryStreak = 0;
        lastServerMsg = null;
      } else {
        // 서버 안내는 결과로 치지 않는다. 잠시 기다린 뒤 같은 씬이라도 다시 시도하되,
        // 같은 씬에서 반복되면 대기 시간을 두 배씩 늘려 불필요한 호출을 줄인다.
        hasResult = false;
        retryStreak += 1;
        retryAt = now() + Math.min(retryHoldMaxMs, retryHoldMs * 2 ** (retryStreak - 1));
        // too_dark는 기기의 플래시 지원 여부에 따라 문구가 달라지므로 서버 문구 대신 로컬 문구를 쓴다.
        const msg = res?.quality === "too_dark" ? localHint("too_dark") : res?.message_ko || localHint(res?.quality);
        serverHint = Boolean(msg);
        lastServerMsg = msg || null;
        if (msg) call(onHint, msg);
      }
      call(onResult, res);
    } catch (err) {
      if (gen !== generation) return;
      // resultSample은 남겨 둔다: 앱이 유지하는 이전 오버레이를 씬 변화로 지울 수 있어야 한다.
      hasResult = false;
      errorStreak += 1;
      backoffUntil = now() + Math.min(errorBackoffMaxMs, errorBackoffMs * 2 ** (errorStreak - 1));
      call(onError, err);
    } finally {
      // stop() 뒤에 응답이 와도 바쁨 표시는 반드시 해제한다.
      busy = false;
      call(onBusy, false);
    }
  }

  function step() {
    // 샘플링 단계에서는 JPEG 인코딩을 생략한다 (250ms마다 1024px를 인코딩할 필요가 없다).
    const frame = capture({ encode: false });
    if (!frame || !frame.imageData) return;
    const sample = frame.imageData;
    const prev = prevSample;
    prevSample = sample;

    let verdict = analyze(sample)?.verdict;
    if (verdict === "blurry") {
      // 정지 화면(안정)인데 계속 흐림이면 손떨림이 아니라 질감이 적은 장면이다. 잠시 뒤 서버 판정에 맡긴다.
      const stable = prev && diff(prev, sample) <= stableDiff;
      if (!stable) blurrySince = -Infinity;
      else if (blurrySince === -Infinity) blurrySince = now();
      if (stable && now() - blurrySince >= blurGraceMs) verdict = "ok";
    } else {
      blurrySince = -Infinity;
    }
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
      lastServerMsg = null;
    }
    if (!serverHint) {
      // 잠깐의 로컬 안내가 서버 안내를 덮었다면, 재시도 대기 중에는 서버 안내를 다시 보여준다.
      if (lastServerMsg && now() < retryAt) {
        serverHint = true;
        call(onHint, lastServerMsg);
      } else {
        call(onHint, null);
      }
    }
    if (droppedResult) call(onSceneChange);

    if (hasResult || busy) return;
    if (!prev || diff(prev, sample) > stableDiff) return;
    const t = now();
    if (t < backoffUntil || t < retryAt) return;
    if (t - lastRequestAt < minIntervalMs) return;
    const full = frame.base64 ? frame : capture();
    if (!full || !full.base64) return;
    request(full, sample);
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

  // 사용자가 다시 켰거나 화면으로 돌아왔다: 재시도 대기와 오류 백오프는 초기화한다.
  function start() {
    if (running) return;
    running = true;
    prevSample = null;
    retryAt = -Infinity;
    backoffUntil = -Infinity;
    blurrySince = -Infinity;
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

  // 카메라를 다시 열었을 때처럼 이전 결과가 더 이상 화면과 무관해졌을 때 부른다. 루프 상태는 바꾸지 않는다.
  function reset() {
    prevSample = null;
    hasResult = false;
    resultSample = null;
    serverHint = false;
    lastServerMsg = null;
    retryAt = -Infinity;
    retryStreak = 0;
    backoffUntil = -Infinity;
    errorStreak = 0;
    blurrySince = -Infinity;
  }

  return { start, stop, scanNow, isRunning, reset };
}
