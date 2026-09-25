// 오케스트레이터: 카메라 -> 스캐너 -> API -> 오버레이/시트. docs/CONTRACT.md 4절 app.js.
import { startCamera, captureFrame, setTorch, stopCamera } from "./camera.js";
import { analyzeFrame, frameDiff, hintFor } from "./quality.js";
import { createScanner } from "./scanner.js";
import { renderOverlay, clearOverlay } from "./overlay.js";
import { openSheet, closeSheet } from "./sheet.js";
import { identify } from "./api.js";

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

const state = {
  stream: null,
  track: null,
  torchSupported: false,
  torchOn: false,
  lastResult: null,
  autoScan: true,
  scanner: null,
};

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
  hintEl.textContent = message;
  hintEl.dataset.kind = kind;
  hintEl.hidden = false;
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
    onSelect: (plant) => openSheet(sheetEl, plant),
  });
  const names = result.plants.map((p) => p.name_ko).join(", ");
  setStatus(`${result.plants.length}개 식물: ${names}`);
}

function handleResult(result) {
  if (result.quality !== "ok") {
    paintResult(null);
    showHint(result.message_ko || hintFor(result.quality, { torchSupported: state.torchSupported }));
    setStatus("");
    return;
  }
  showHint(null);
  paintResult(result);
}

// 요청 실패: 안내만 띄우고 이미 그려진 결과는 그대로 둔다 (스캐너가 백오프 후 다시 시도한다).
function handleError(err) {
  showHint(err?.message_ko || "알 수 없는 오류가 발생했습니다.", "error");
  if (!state.lastResult) setStatus("");
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
    state.scanner?.start();
    setStatus("자동 인식 중");
  } else {
    state.scanner?.stop();
    setStatus("자동 인식 꺼짐");
  }
}

function buildScanner() {
  return createScanner({
    capture: () => captureFrame(videoEl),
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
    onResult: handleResult,
    onError: handleError,
    onBusy: (busy) => {
      setState(busy ? "busy" : "ready");
      btnScan.disabled = busy;
      if (busy) setStatus("인식 중");
    },
  });
}

async function boot() {
  setState("starting");
  setStatus("카메라를 여는 중");
  try {
    const cam = await startCamera(videoEl, { facingMode: "environment" });
    state.stream = cam.stream;
    state.track = cam.track;
    state.torchSupported = Boolean(cam.torchSupported);
    btnTorch.hidden = !state.torchSupported;
  } catch (err) {
    setState("error");
    const messages = {
      denied: "카메라 사용 권한이 필요합니다. 브라우저 설정에서 카메라를 허용해 주세요.",
      not_found: "사용할 수 있는 카메라를 찾지 못했습니다.",
      insecure: "카메라는 HTTPS 주소에서만 사용할 수 있습니다.",
    };
    showHint(messages[err?.code] || "카메라를 열 수 없습니다.", "error");
    setStatus("");
    return;
  }

  setState("ready");
  setStatus("자동 인식 중");
  state.scanner = buildScanner();
  if (state.autoScan) state.scanner.start();
}

btnScan.addEventListener("click", () => state.scanner?.scanNow());
btnTorch.addEventListener("click", toggleTorch);
btnAuto.addEventListener("click", toggleAuto);
sheetEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-sheet-close]")) closeSheet(sheetEl);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet(sheetEl);
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
  } else if (state.autoScan) {
    state.scanner?.start();
  }
});

window.addEventListener("pagehide", () => {
  state.scanner?.stop();
  if (state.stream) stopCamera(state.stream);
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// 테스트에서 상태를 들여다볼 수 있도록 노출한다.
window.__gardenLens = state;

boot();
