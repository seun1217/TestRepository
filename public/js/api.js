// 서버 프록시 호출. docs/CONTRACT.md 2절.
// 비전 모델 응답은 수십 초가 걸릴 수 있다. 서버의 SDK 타임아웃(60초)보다 짧게 둔다.
const DEFAULT_TIMEOUT_MS = 45000;

export async function identify({ base64, width, height, lang = "ko", signal, debug } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetch("/api/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, width, height, lang, ...(debug ? { debug } : {}) }),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const err = new Error(payload?.error?.code || `http_${res.status}`);
      err.code = payload?.error?.code || "http_error";
      err.status = res.status;
      err.message_ko = payload?.error?.message_ko || "서버와 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.";
      throw err;
    }
    if (!payload || typeof payload !== "object") {
      const err = new Error("bad_payload");
      err.code = "bad_payload";
      err.message_ko = "서버 응답을 읽을 수 없습니다.";
      throw err;
    }
    return payload;
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error("timeout");
      e.code = "timeout";
      e.message_ko = "응답이 너무 오래 걸립니다. 네트워크 상태를 확인해 주세요.";
      throw e;
    }
    if (!err.message_ko) {
      err.code = err.code || "network";
      err.message_ko = "네트워크에 연결할 수 없습니다.";
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
