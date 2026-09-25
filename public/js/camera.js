// 카메라 제어 (브라우저 전용). docs/CONTRACT.md 4절 camera.js.
// 품질 분석용 샘플은 항상 같은 크기다. 회전이나 주소창 표시로 보이는 영역의 비율이 바뀌어도
// 샘플 크기가 그대로여야 frameDiff가 "크기 불일치 = 씬 변화"로 오판하지 않는다 (왜곡은 밝기/선명도 판정에 영향이 없다).
const SAMPLE_W = 160;
const SAMPLE_H = 120;
const READY_TIMEOUT_MS = 5000; // videoWidth가 채워지길 기다리는 최대 시간
const READY_POLL_MS = 50;

// 모듈 수준 캔버스 재사용: 전체 캡처용 하나, 분석 샘플용 하나.
let captureCanvas = null;
let captureCtx = null;
let sampleCanvas = null;
let sampleCtx = null;

function makeError(code, cause) {
  const err = new Error(cause?.message || `camera_${code}`);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// getUserMedia 오류를 계약의 error.code로 매핑한다.
function mapMediaError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "not_found";
  return "unknown";
}

function isOverconstrained(err) {
  const name = err?.name || "";
  return name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError";
}

// loadedmetadata 이벤트 또는 폴링으로 videoWidth > 0이 될 때까지 기다린다. 시간 초과 시 false.
function waitForVideoSize(videoEl, timeoutMs) {
  return new Promise((resolve) => {
    if (videoEl.videoWidth > 0) {
      resolve(true);
      return;
    }
    let done = false;
    let pollTimer = 0;
    let capTimer = 0;
    const finish = (ok) => {
      if (done) return;
      done = true;
      videoEl.removeEventListener("loadedmetadata", check);
      clearInterval(pollTimer);
      clearTimeout(capTimer);
      resolve(ok);
    };
    const check = () => {
      if (videoEl.videoWidth > 0) finish(true);
    };
    videoEl.addEventListener("loadedmetadata", check);
    pollTimer = setInterval(check, READY_POLL_MS);
    capTimer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function startCamera(videoEl, { facingMode = "environment" } = {}) {
  const media = globalThis.navigator?.mediaDevices;
  if (!globalThis.isSecureContext || typeof media?.getUserMedia !== "function") {
    throw makeError("insecure");
  }

  const constraints = {
    video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  };

  let stream;
  try {
    stream = await media.getUserMedia(constraints);
  } catch (err) {
    if (!isOverconstrained(err)) throw makeError(mapMediaError(err), err);
    // 제약을 만족하는 카메라가 없으면 한 번만 기본 설정으로 재시도한다.
    try {
      stream = await media.getUserMedia({ video: true, audio: false });
    } catch (retryErr) {
      throw makeError(mapMediaError(retryErr), retryErr);
    }
  }

  videoEl.srcObject = stream;
  try {
    await videoEl.play();
  } catch (err) {
    // 새 재생 요청이 이전 요청을 끊으면 AbortError가 나는데, 스트림 자체는 정상이므로 무시한다.
    if (err?.name !== "AbortError") {
      stopCamera(stream);
      videoEl.srcObject = null;
      throw makeError("unknown", err);
    }
  }

  await waitForVideoSize(videoEl, READY_TIMEOUT_MS);

  const track = stream.getVideoTracks()[0] || null;
  let torchSupported = false;
  try {
    torchSupported = track?.getCapabilities?.()?.torch === true;
  } catch {
    torchSupported = false;
  }
  return { stream, track, torchSupported };
}

function ensureCanvases() {
  if (!captureCanvas) {
    captureCanvas = document.createElement("canvas");
    captureCtx = captureCanvas.getContext("2d");
  }
  if (!sampleCanvas) {
    sampleCanvas = document.createElement("canvas");
    sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  }
  for (const ctx of [captureCtx, sampleCtx]) {
    if (ctx && "imageSmoothingQuality" in ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
  }
}

// 긴 변이 maxSide가 되도록 축소한 크기. 절대 확대하지 않는다.
function fitSize(w, h, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function resizeCanvas(canvas, w, h) {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

const isPositive = (v) => Number.isFinite(v) && v > 0;
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));

// object-fit: cover로 실제 보이는 원본 영역 (비디오 픽셀 단위 정수). 비디오 중앙에서 view의 종횡비를 가진 최대 사각형.
// viewW 또는 viewH가 0이거나 비정상이면 자르지 않고 전체 프레임을 돌려준다.
function computeCropRect(videoW, videoH, viewW, viewH) {
  if (!isPositive(viewW) || !isPositive(viewH)) return { sx: 0, sy: 0, sw: videoW, sh: videoH, videoW, videoH };
  const scale = Math.max(viewW / videoW, viewH / videoH);
  const sw = clampInt(viewW / scale, 1, videoW);
  const sh = clampInt(viewH / scale, 1, videoH);
  const sx = Math.round((videoW - sw) / 2);
  const sy = Math.round((videoH - sh) / 2);
  return { sx, sy, sw, sh, videoW, videoH };
}

// 보이는 영역(object-fit: cover)만 잘라 JPEG로 만든다. bbox는 이 잘린 이미지 기준이므로 crop을 함께 돌려준다.
// encode: false이면 JPEG 인코딩을 생략하고 dataUrl/base64를 null로 둔다 (품질 샘플링 전용).
export function captureFrame(videoEl, { maxSide = 1024, quality = 0.85, viewW, viewH, encode = true } = {}) {
  const vw = videoEl?.videoWidth | 0;
  const vh = videoEl?.videoHeight | 0;
  if (vw <= 0 || vh <= 0) return null;
  const crop = computeCropRect(vw, vh, viewW ?? videoEl.clientWidth, viewH ?? videoEl.clientHeight);

  try {
    ensureCanvases();
    if (!captureCtx || !sampleCtx) return null;

    const full = fitSize(crop.sw, crop.sh, maxSide);
    resizeCanvas(captureCanvas, full.w, full.h);
    captureCtx.drawImage(videoEl, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, full.w, full.h);
    const dataUrl = encode ? captureCanvas.toDataURL("image/jpeg", quality) : null;
    const base64 = dataUrl ? dataUrl.slice(dataUrl.indexOf(",") + 1) : null;

    // 분석 샘플은 이미 잘려 축소된 캡처 캔버스에서 한 번 더 줄여 앨리어싱을 줄인다.
    resizeCanvas(sampleCanvas, SAMPLE_W, SAMPLE_H);
    sampleCtx.drawImage(captureCanvas, 0, 0, SAMPLE_W, SAMPLE_H);
    const imageData = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);

    return { dataUrl, base64, width: full.w, height: full.h, imageData, crop };
  } catch {
    // 비디오가 아직 그릴 수 없는 상태이거나 캔버스 오류: 이번 프레임은 건너뛴다.
    return null;
  }
}

export async function setTorch(track, on) {
  if (!track || typeof track.applyConstraints !== "function") return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  } catch {
    return false;
  }
}

export function stopCamera(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // 이미 멈춘 트랙은 무시한다.
    }
  }
}
