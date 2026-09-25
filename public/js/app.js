// 오케스트레이터: 카메라 -> 스캐너 -> API -> 오버레이/시트. docs/CONTRACT.md 4절 app.js.
import { startCamera, captureFrame, setTorch, stopCamera } from "./camera.js";
import { analyzeFrame, frameDiff, hintFor } from "./quality.js";
import { createScanner } from "./scanner.js";
import { renderOverlay, clearOverlay } from "./overlay.js";
import { openSheet, closeSheet, setSheetDetail } from "./sheet.js";
import { identify, describe } from "./api.js";

const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const videoEl = $("#video");
const overlayEl = $("#overlay");
const hintEl = $("#hint");
const statusEl = $("#status");
const sheetEl = $("#sheet");
const btnScan = $("#btn-scan");
const btnTorch = $("#btn-torch");
const btnAuto = $("#btn-toggle-auto");
const viewportEl = $("#viewport");
const toolbarEl = $("#toolbar");

const state = {
  stream: null,
  track: null,
  torchSupported: false,
  torchOn: false,
  lastResult: null,
  autoScan: true,
  scanner: null,
  sheetPlant: null, // 시트에 보이는 식물 객체 (id는 결과마다 p1, p2로 반복되므로 객체로 구분한다)
  describing: new WeakMap(), // 식물 객체 -> 진행 중인 describe 약속 (같은 식물에 요청을 겹쳐 보내지 않는다)
};

const NO_FRAME_MESSAGE = "이 결과에 사용할 이미지가 없습니다. 다시 인식해 주세요.";
const DESCRIBE_FALLBACK_MESSAGE = "상세 설명을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";

function setState(name) {
  app.dataset.state = name;
}

function showHint(message, kind = "info") {
  if (!message) {
    hintEl.hidden = true;
    hintEl.textContent = "";
    delete hintEl.dataset.kind;
    return;
  }
  // 같은 안내를 반복해서 쓰지 않는다 (role=status 라이브 영역이 250ms마다 다시 읽히는 것을 막는다).
  if (!hintEl.hidden && hintEl.textContent === message && hintEl.dataset.kind === kind) return;
  hintEl.textContent = message;
  hintEl.dataset.kind = kind;
  hintEl.hidden = false;
}

// 현재 상태에 맞는 상태 문구로 되돌린다 (요청 종료, 카메라 복구 뒤).
function restoreStatus() {
  const r = state.lastResult;
  if (r?.quality === "ok" && r.plants?.length) {
    setStatus(`식물 ${r.plants.length}개: ${r.plants.map((p) => p.name_ko).join(", ")}`);
  } else {
    setStatus(state.autoScan ? "자동 인식 중" : "자동 인식 꺼짐");
  }
}

function setStatus(text) {
  statusEl.textContent = text || "";
}

function paintResult(result) {
  state.lastResult = result;
  if (!result || result.quality !== "ok" || !result.plants?.length) {
    clearOverlay(overlayEl);
    return;
  }
  renderOverlay(overlayEl, result.plants, {
    videoEl,
    crop: result.frame?.crop || null,
    onSelect: openDetail,
  });
  const names = result.plants.map((p) => p.name_ko).join(", ");
  setStatus(`식물 ${result.plants.length}개: ${names}`);
}

function isSheetOpen() {
  return !sheetEl.hidden;
}

// 2단계: 시트에 보이는 식물의 상세 설명을 받는다. 성공하면 식물 객체에 캐시하고, 늦게 온 응답은 시트가 그 식물을 보여줄 때만 반영한다.
function requestDetail(plant) {
  if (!plant || state.describing.has(plant)) return;
  const frame = state.lastResult?.frame;
  if (!frame?.base64) {
    setSheetDetail(sheetEl, plant.id, { error: NO_FRAME_MESSAGE });
    return;
  }
  const pending = describe({ ...frame, plant })
    .then((res) => {
      const detail = String(res?.detail_ko || "").trim();
      if (!detail) throw Object.assign(new Error("empty_detail"), { message_ko: DESCRIBE_FALLBACK_MESSAGE });
      plant.detail_ko = detail;
      if (state.sheetPlant === plant) setSheetDetail(sheetEl, plant.id, { detail_ko: detail });
    })
    .catch((err) => {
      if (state.sheetPlant !== plant) return;
      setSheetDetail(sheetEl, plant.id, {
        error: err?.message_ko || DESCRIBE_FALLBACK_MESSAGE,
        onRetry: () => {
          setSheetDetail(sheetEl, plant.id, {});
          requestDetail(plant);
        },
      });
    })
    .finally(() => state.describing.delete(plant));
  state.describing.set(plant, pending);
}

// 툴팁 선택: 사용자가 읽는 동안 씬이 바뀌어도 요청하지 않도록 스캐너를 멈추고 시트를 연다.
function openDetail(plant) {
  state.sheetPlant = plant;
  state.scanner?.stop();
  // 시트가 열린 동안 뒤쪽 화면은 키보드로도 닿지 않게 한다.
  viewportEl.inert = true;
  toolbarEl.inert = true;
  openSheet(sheetEl, plant);
  if (!plant?.detail_ko) requestDetail(plant);
}

// 닫기 버튼, 배경, Escape가 모두 여기로 온다. 이미 닫혀 있으면 아무것도 하지 않는다.
function closeDetail() {
  if (!isSheetOpen()) return;
  const plantId = state.sheetPlant?.id;
  closeSheet(sheetEl);
  state.sheetPlant = null;
  viewportEl.inert = false;
  toolbarEl.inert = false;
  // 시트가 열린 사이 오버레이가 다시 그려졌으면 같은 식물의 툴팁(없으면 인식 버튼)으로 포커스를 보낸다.
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !sheetEl.contains(active)) return;
    const tip = plantId != null ? overlayEl.querySelector(`.plant-tip[data-plant-id="${CSS.escape(String(plantId))}"]`) : null;
    (tip || btnScan).focus({ preventScroll: true });
  }, 320);
  if (state.autoScan && !document.hidden) state.scanner?.start();
}

function handleResult(result) {
  if (result.quality !== "ok") {
    paintResult(null);
    const local = hintFor(result.quality, { torchSupported: state.torchSupported, torchOn: state.torchOn });
    showHint(result.quality === "too_dark" ? local : result.message_ko || local);
    setStatus("");
    return;
  }
  showHint(null);
  paintResult(result);
}

// 요청 실패: 안내만 띄우고 이미 그려진 결과는 그대로 둔다 (스캐너가 백오프 후 다시 시도한다).
function handleError(err) {
  showHint(err?.message_ko || "알 수 없는 오류가 발생했습니다.", "error");
  restoreStatus();
}

// 씬이 바뀌어 스캐너가 결과를 버렸다: 오버레이를 지우고 다음 결과를 기다린다.
function handleSceneChange() {
  paintResult(null);
  showHint(null);
  setStatus(state.autoScan ? "자동 인식 중" : "");
}

async function toggleTorch() {
  if (!state.track) return;
  const next = !state.torchOn;
  const ok = await setTorch(state.track, next);
  if (ok) {
    state.torchOn = next;
    btnTorch.setAttribute("aria-pressed", String(next));
    if (next) showHint(null);
  } else {
    showHint("이 기기에서는 앱에서 플래시를 켤 수 없습니다. 기기 손전등을 켜 주세요.");
  }
}

function toggleAuto() {
  state.autoScan = !state.autoScan;
  btnAuto.setAttribute("aria-pressed", String(state.autoScan));
  if (state.autoScan) {
    if (!isSheetOpen()) state.scanner?.start();
    setStatus("자동 인식 중");
  } else {
    state.scanner?.stop();
    setStatus("자동 인식 꺼짐");
  }
}

function buildScanner() {
  return createScanner({
    capture: (opts) => captureFrame(videoEl, opts),
    analyze: analyzeFrame,
    diff: frameDiff,
    // 결과에 보낸 프레임을 붙여 둔다: overlay는 crop으로 좌표를 되돌리고, describe는 같은 이미지를 다시 보낸다.
    identify: async ({ base64, width, height, crop }) => {
      const result = await identify({ base64, width, height });
      if (result && typeof result === "object") result.frame = { base64, width, height, crop: crop || null };
      return result;
    },
    // 로컬 품질 안내: 툴팁은 유지한 채 안내만 띄운다. 씬이 실제로 바뀌면 onSceneChange가 지운다.
    onHint: (msg) => {
      if (msg) showHint(msg);
      else if (hintEl.dataset.kind !== "error") showHint(null);
    },
    onSceneChange: handleSceneChange,
    torchSupported: () => state.torchSupported,
    torchOn: () => state.torchOn,
    onResult: handleResult,
    onError: handleError,
    onBusy: (busy) => {
      setState(busy ? "busy" : "ready");
      btnScan.disabled = busy;
      if (busy) setStatus("인식 중");
      else restoreStatus();
    },
  });
}

// 카메라를 열고 상태에 기록한다. 트랙이 끊기면(잠금 화면, 앱 전환, iOS의 백그라운드 처리) 복구 경로로 이어진다.
async function openCamera() {
  const cam = await startCamera(videoEl, { facingMode: "environment" });
  state.stream = cam.stream;
  state.track = cam.track;
  state.torchSupported = Boolean(cam.torchSupported);
  state.torchOn = false;
  btnTorch.hidden = !state.torchSupported;
  btnTorch.setAttribute("aria-pressed", "false");
  const track = state.track;
  track?.addEventListener?.("ended", () => {
    if (!document.hidden) ensureCameraLive();
  });
  // 통화나 다른 앱이 카메라를 가져가면 트랙이 mute된다. 멈춘 마지막 프레임을 인식(과금)하지 않도록 스캐너를 멈춘다.
  track?.addEventListener?.("mute", () => {
    if (state.track !== track) return;
    state.scanner?.stop();
    showHint("카메라 화면이 잠시 멈췄습니다. 다른 앱이 카메라를 사용 중이면 닫아 주세요.");
  });
  track?.addEventListener?.("unmute", () => {
    if (state.track !== track || document.hidden) return;
    showHint(null);
    if (state.autoScan && !isSheetOpen()) state.scanner?.start();
  });
}

function cameraIsLive() {
  return Boolean(state.track && state.track.readyState === "live");
}

// 브라우저가 백그라운드에서 트랙을 mute했다가 포그라운드에서 unmute하기까지 잠깐 걸린다. 그 사이 기다린다.
function waitForUnmute(track, timeoutMs) {
  return new Promise((resolve) => {
    if (!track || !track.muted) return resolve(true);
    let timer = 0;
    const done = (ok) => {
      clearTimeout(timer);
      track.removeEventListener("unmute", onUnmute);
      resolve(ok);
    };
    const onUnmute = () => done(true);
    track.addEventListener("unmute", onUnmute);
    timer = setTimeout(() => done(!track.muted), timeoutMs);
  });
}

// 화면으로 돌아왔거나 트랙이 끊겼을 때: 살아 있는 트랙이 없으면 카메라를 다시 연 뒤 스캐너를 재개한다.
// 끊긴 트랙 위에서는 마지막 프레임이 그대로 멈춰 "안정"으로 보이므로, 그 화면을 인식해 과금하는 일을 막는다.
let resuming = null;
async function ensureCameraLive() {
  if (resuming) return resuming;
  resuming = (async () => {
    state.scanner?.stop();
    if (cameraIsLive() && state.track.muted) {
      // 아직 unmute 전이면 잠시 기다린다. 끝내 풀리지 않으면 다시 연다.
      const ok = await waitForUnmute(state.track, 3000);
      if (!ok && state.stream) {
        stopCamera(state.stream);
        state.stream = null;
        state.track = null;
      }
    }
    if (!cameraIsLive()) {
      if (state.stream) stopCamera(state.stream);
      state.stream = null;
      state.track = null;
      setStatus("카메라를 다시 여는 중");
      try {
        await openCamera();
      } catch {
        setState("error");
        showHint("카메라를 다시 열 수 없습니다. 잠시 후 '지금 인식' 버튼을 눌러 다시 시도해 주세요.", "error");
        setStatus("");
        return;
      }
      state.scanner?.reset(); // 이전 결과는 새 스트림과 무관하다
      paintResult(null);
      showHint(null);
      setState("ready");
    }
    if (state.autoScan && !isSheetOpen() && !document.hidden) state.scanner?.start();
    restoreStatus();
  })().finally(() => {
    resuming = null;
  });
  return resuming;
}

// 카메라가 열리는 사이 "지금 인식"을 눌러도 두 번째 부팅(스트림과 스캐너 중복)이 생기지 않게 한 번에 하나만 돈다.
let booting = null;
function boot() {
  if (booting) return booting;
  booting = bootOnce().finally(() => {
    booting = null;
  });
  return booting;
}

async function bootOnce() {
  setState("starting");
  setStatus("카메라를 여는 중");
  try {
    await openCamera();
  } catch (err) {
    setState("error");
    const messages = {
      denied: "카메라 사용 권한이 필요합니다. 브라우저나 기기 설정에서 카메라를 허용한 뒤 '지금 인식' 버튼을 눌러 주세요.",
      not_found: "사용할 수 있는 카메라를 찾지 못했습니다.",
      insecure: "카메라는 HTTPS 주소에서만 사용할 수 있습니다.",
      no_frames: "카메라 화면을 받지 못했습니다. 다른 앱이 카메라를 사용 중이면 닫고 '지금 인식' 버튼을 눌러 주세요.",
    };
    showHint(messages[err?.code] || "카메라를 열 수 없습니다.", "error");
    setStatus("");
    return;
  }

  setState("ready");
  setStatus("자동 인식 중");
  state.scanner = buildScanner();
  if (state.autoScan && !document.hidden) state.scanner.start();
}

btnScan.addEventListener("click", () => {
  if (isSheetOpen()) return;
  // 권한 거부 등으로 카메라를 못 열었으면 이 버튼이 재시도 경로다 (설치형 PWA에는 새로 고침이 없다).
  if (!state.stream) {
    if (state.scanner) ensureCameraLive();
    else boot();
    return;
  }
  state.scanner?.scanNow();
});
btnTorch.addEventListener("click", toggleTorch);
btnAuto.addEventListener("click", toggleAuto);
sheetEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-sheet-close]")) closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

let resizeTimer = 0;
function onLayoutChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.lastResult?.quality === "ok") paintResult(state.lastResult);
  }, 120);
}
window.addEventListener("resize", onLayoutChange);
window.addEventListener("orientationchange", onLayoutChange);
videoEl.addEventListener("loadedmetadata", onLayoutChange);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.scanner?.stop();
  } else if (state.scanner) {
    ensureCameraLive();
  } else if (!state.stream && app.dataset.state === "error") {
    boot(); // 설정에서 권한을 허용하고 돌아온 경우: 조용히 다시 시도한다
  }
});

window.addEventListener("pagehide", () => {
  state.scanner?.stop();
  if (state.stream) stopCamera(state.stream);
});

// bfcache에서 돌아오면 pagehide로 멈춘 스트림을 다시 연다.
window.addEventListener("pageshow", () => {
  if (state.scanner && !document.hidden) ensureCameraLive();
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// 테스트에서 상태를 들여다볼 수 있도록 노출한다.
window.__gardenLens = state;

boot();
