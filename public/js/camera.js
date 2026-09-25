// 카메라 제어. docs/CONTRACT.md 4절 camera.js. 구현은 워크플로우 에이전트가 채운다.
export async function startCamera(videoEl, { facingMode = "environment" } = {}) {
  throw Object.assign(new Error("camera.js not implemented"), { code: "unknown" });
}

export function captureFrame(videoEl, { maxSide = 1024, quality = 0.85 } = {}) {
  return null;
}

export async function setTorch(track, on) {
  return false;
}

export function stopCamera(stream) {}
