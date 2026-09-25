// 서버 프록시 호출. docs/CONTRACT.md 2절.
// 비전 모델 응답은 수십 초가 걸릴 수 있다. 서버의 SDK 타임아웃(40초, 재시도 없음)보다 길게 두어 서버가 먼저 포기하게 한다.
const DEFAULT_TIMEOUT_MS = 45000;

const MESSAGES = {
  http: "서버와 통신하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  bad_payload: "서버 응답을 읽을 수 없습니다.",
  timeout: "응답이 너무 오래 걸립니다. 네트워크 상태를 확인해 주세요.",
  network: "네트워크에 연결할 수 없습니다.",
};

function makeError(code, message_ko, extra = {}) {
  const err = new Error(code);
  err.code = code;
  err.message_ko = message_ko;
  Object.assign(err, extra);
  return err;
}

// identify와 describe가 공유하는 POST 호출: 타임아웃, 외부 signal, 오류 응답 -> Error(code, status, message_ko).
async function postJson(path, body, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      throw makeError(payload?.error?.code || "http_error", payload?.error?.message_ko || MESSAGES.http, {
        status: res.status,
      });
    }
    if (!payload || typeof payload !== "object") throw makeError("bad_payload", MESSAGES.bad_payload);
    return payload;
  } catch (err) {
    if (err?.name === "AbortError") throw makeError("timeout", MESSAGES.timeout);
    if (!err.message_ko) {
      err.code = err.code || "network";
      err.message_ko = MESSAGES.network;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 1단계: 이름, 학명, 요약, bbox (detail_ko는 비어 있을 수 있다). debug는 mock 제공자 전용.
export async function identify({ base64, width, height, lang = "ko", signal, debug } = {}) {
  return postJson("/api/identify", { image: base64, width, height, lang, ...(debug ? { debug } : {}) }, { signal });
}

// 2단계: 같은 이미지에서 식물 하나의 상세 설명. -> { detail_ko, model, usage }
export async function describe({ base64, width, height, plant, lang = "ko", signal, debug } = {}) {
  const p = plant || {};
  const body = {
    image: base64,
    width,
    height,
    lang,
    plant: { id: p.id, name_ko: p.name_ko, name_sci: p.name_sci, bbox: p.bbox },
    ...(debug ? { debug } : {}),
  };
  return postJson("/api/describe", body, { signal });
}
