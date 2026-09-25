// Garden Lens 서버: 정적 파일 서빙 + 비전 모델 프록시.
// API 키는 이 프로세스에만 존재하며 브라우저로 전달되지 않는다.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PROVIDER_NAME = (process.env.IDENTIFY_PROVIDER || "claude").toLowerCase();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";

// 프록시 뒤에서만 X-Forwarded-For를 믿는다. TRUST_PROXY=1 (hop 수), true, 또는 "loopback, 10.0.0.0/8" 같은 목록.
function parseTrustProxy(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const v = String(raw).trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// IP당 분당 요청 수. RATE_LIMIT_PER_MIN=0이면 제한을 끈다. 잘못된 값이면 기본값 20.
function parseRateLimit(raw) {
  if (raw == null || String(raw).trim() === "") return 20;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}
const RATE_LIMIT_PER_MIN = parseRateLimit(process.env.RATE_LIMIT_PER_MIN);
const RATE_WINDOW_MS = 60_000;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MIN_CONFIDENCE = 0.35;
const MAX_PLANT_TEXT = 120; // describe 요청의 name_ko, name_sci, id 최대 길이
const MAX_PLANTS = 6;

const QUALITY_MESSAGES = {
  too_dark: "너무 어둡습니다. 플래시를 켜거나 더 밝은 곳에서 비춰 주세요.",
  too_far: "식물이 너무 멀리 있습니다. 더 가까이 다가가 주세요.",
  blurry: "화면이 흔들립니다. 카메라를 잠시 고정해 주세요.",
  no_plant: "화면에서 식물을 찾지 못했습니다. 식물이 화면 가운데 오도록 비춰 주세요.",
};

// 제공자 모듈. default는 identify, 이름 있는 describe export는 선택 (없으면 /api/describe가 502로 답한다).
async function loadProvider(name) {
  return import(`./providers/${name === "mock" ? "mock" : "claude"}.js`);
}

const provider = await loadProvider(PROVIDER_NAME);
const identifyWithProvider = provider.default;
const describeWithProvider = typeof provider.describe === "function" ? provider.describe : null;

const app = express();
app.disable("x-powered-by");
if (TRUST_PROXY != null) app.set("trust proxy", TRUST_PROXY);

// API 응답은 캐시하지 않는다. 본문 파싱 오류 응답에도 적용되도록 express.json보다 먼저 건다.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "6mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, provider: PROVIDER_NAME, model: MODEL });
});

function sendError(res, status, code, message_ko) {
  res.status(status).json({ error: { code, message_ko } });
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// bbox를 0..1로 클램프하고 w, h는 이미지 가장자리에서 자른다.
function clampBBox(b) {
  const x = clamp01(b?.x);
  const y = clamp01(b?.y);
  return { x, y, w: Math.min(clamp01(b?.w), 1 - x), h: Math.min(clamp01(b?.h), 1 - y) };
}

// 제공자 응답을 계약(docs/CONTRACT.md)에 맞게 정규화한다.
export function normalizeResponse(raw, model) {
  const out = {
    quality: "ok",
    message_ko: null,
    plants: [],
    model: raw?.model || model,
    usage: {
      input_tokens: Number(raw?.usage?.input_tokens) || 0,
      output_tokens: Number(raw?.usage?.output_tokens) || 0,
    },
  };
  const quality = typeof raw?.quality === "string" ? raw.quality : "ok";
  if (quality !== "ok") {
    out.quality = QUALITY_MESSAGES[quality] ? quality : "no_plant";
    out.message_ko = raw?.message_ko || QUALITY_MESSAGES[out.quality];
    return out;
  }
  const plants = Array.isArray(raw?.plants) ? raw.plants : [];
  const cleaned = plants
    .map((p) => {
      return {
        id: "",
        name_ko: String(p?.name_ko || "").trim() || "이름 미상",
        name_sci: String(p?.name_sci || "").trim(),
        name_en: String(p?.name_en || "").trim(),
        family_ko: String(p?.family_ko || "").trim(),
        confidence: clamp01(p?.confidence),
        bbox: clampBBox(p?.bbox),
        summary_ko: String(p?.summary_ko || "").trim(),
        // 1단계에서는 비어 있을 수 있다 (계약 2절). 클라이언트가 비어 있을 때만 describe를 부른다.
        detail_ko: String(p?.detail_ko || "").trim(),
        tags: Array.isArray(p?.tags) ? p.tags.map((t) => String(t)).filter(Boolean).slice(0, 8) : [],
      };
    })
    .filter((p) => p.confidence >= MIN_CONFIDENCE && p.bbox.w > 0 && p.bbox.h > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_PLANTS)
    .map((p, i) => ({ ...p, id: `p${i + 1}` }));

  if (cleaned.length === 0) {
    out.quality = plants.length === 0 ? "no_plant" : "too_far";
    out.message_ko = QUALITY_MESSAGES[out.quality];
    return out;
  }
  out.plants = cleaned;
  return out;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// 메모리 고정 윈도우 요청 제한 (IP당 분당 RATE_LIMIT_PER_MIN회). 프로세스 하나 기준이며 재시작하면 초기화된다.
const rateBuckets = new Map();
function sweepRateBuckets(now) {
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}
const rateSweeper = setInterval(() => sweepRateBuckets(Date.now()), RATE_WINDOW_MS);
rateSweeper.unref();

// identify와 describe가 같은 버킷을 쓴다 (둘을 합쳐 분당 RATE_LIMIT_PER_MIN회).
function rateLimitApi(req, res, next) {
  if (RATE_LIMIT_PER_MIN <= 0) return next();
  const now = Date.now();
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  res.set("X-RateLimit-Limit", String(RATE_LIMIT_PER_MIN));
  res.set("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_PER_MIN - bucket.count)));
  if (bucket.count > RATE_LIMIT_PER_MIN) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    return sendError(res, 429, "rate_limited", "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
  }
  next();
}

// identify와 describe가 공유하는 이미지/크기/언어 검증 (계약 2절). 실패하면 { error: message_ko }를 돌려준다.
function parseImageRequest(body) {
  let image = typeof body.image === "string" ? body.image.trim() : "";
  const dataUrlMatch = image.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
  let mediaType = "image/jpeg";
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1] === "image/jpg" ? "image/jpeg" : dataUrlMatch[1];
    image = dataUrlMatch[2];
  }
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    return { error: "지원하지 않는 이미지 형식입니다. JPEG, PNG, WebP, GIF만 보낼 수 있습니다." };
  }
  image = image.replace(/\s+/g, "");
  if (!image) return { error: "이미지가 비어 있습니다." };
  if (!BASE64_RE.test(image)) return { error: "이미지 형식이 올바르지 않습니다." };
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return { error: "이미지가 너무 큽니다." };
  const width = Number.parseInt(body.width, 10);
  const height = Number.parseInt(body.height, 10);
  if (!(width > 0 && height > 0)) return { error: "이미지 크기 정보가 필요합니다." };
  const lang = body.lang === "ko" || body.lang == null ? "ko" : String(body.lang);
  return { image, mediaType, width, height, lang };
}

// describe 요청의 plant 검증. name_ko는 필수, id와 name_sci는 문자열, bbox는 0..1로 클램프한다.
function parsePlant(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "설명할 식물 정보가 필요합니다." };
  const name_ko = typeof raw.name_ko === "string" ? raw.name_ko.trim() : "";
  if (!name_ko) return { error: "식물 이름이 필요합니다." };
  if (name_ko.length > MAX_PLANT_TEXT) return { error: "식물 이름이 너무 깁니다." };
  const plant = { name_ko };
  for (const key of ["id", "name_sci"]) {
    if (raw[key] == null) continue;
    if (typeof raw[key] !== "string") return { error: "식물 정보 형식이 올바르지 않습니다." };
    // 클라이언트가 보내는 텍스트는 그대로 프롬프트에 들어가므로 길이를 제한한다 (입력 토큰 부풀리기 방지).
    if (raw[key].length > MAX_PLANT_TEXT) return { error: "식물 정보가 너무 깁니다." };
    plant[key] = raw[key].trim();
  }
  if (raw.bbox != null) {
    if (typeof raw.bbox !== "object" || Array.isArray(raw.bbox)) return { error: "식물 정보 형식이 올바르지 않습니다." };
    plant.bbox = clampBBox(raw.bbox);
  }
  return { plant };
}

// 제공자 오류 -> 계약의 오류 응답. 계약에 없는 상태 코드는 502로 뭉뚱그린다.
function sendProviderError(res, route, err, fallbackMessage) {
  const status = err?.status || 502;
  const code = err?.code || (status === 401 ? "no_api_key" : status === 429 ? "rate_limited" : status === 503 ? "refused" : "upstream_error");
  const message_ko = err?.message_ko || fallbackMessage;
  if (status >= 500) console.error(`[${route}] failed:`, err?.message || err);
  sendError(res, [400, 401, 429, 502, 503].includes(status) ? status : 502, code, message_ko);
}

app.post("/api/identify", rateLimitApi, async (req, res) => {
  const body = req.body || {};
  const input = parseImageRequest(body);
  if (input.error) return sendError(res, 400, "bad_request", input.error);

  try {
    const raw = await identifyWithProvider({
      imageBase64: input.image,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      lang: input.lang,
      debug: PROVIDER_NAME === "mock" ? body.debug : undefined,
    });
    res.json(normalizeResponse(raw, MODEL));
  } catch (err) {
    sendProviderError(res, "identify", err, "식물 인식 서버에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
  }
});

// 2단계: 툴팁을 터치했을 때 식물 하나의 상세 설명을 받는다 (계약 2절 /api/describe).
app.post("/api/describe", rateLimitApi, async (req, res) => {
  const body = req.body || {};
  const input = parseImageRequest(body);
  if (input.error) return sendError(res, 400, "bad_request", input.error);
  const parsed = parsePlant(body.plant);
  if (parsed.error) return sendError(res, 400, "bad_request", parsed.error);
  if (!describeWithProvider) {
    return sendError(res, 502, "upstream_error", "이 서버에서는 상세 설명을 제공하지 못합니다. 잠시 후 다시 시도해 주세요.");
  }

  try {
    const raw = await describeWithProvider({
      imageBase64: input.image,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      lang: input.lang,
      plant: parsed.plant,
      debug: PROVIDER_NAME === "mock" ? body.debug : undefined,
    });
    const detail_ko = typeof raw?.detail_ko === "string" ? raw.detail_ko.trim() : "";
    if (!detail_ko) return sendError(res, 502, "upstream_error", "모델 응답을 해석하지 못했습니다. 다시 시도해 주세요.");
    res.json({
      detail_ko,
      model: raw?.model || MODEL,
      usage: {
        input_tokens: Number(raw?.usage?.input_tokens) || 0,
        output_tokens: Number(raw?.usage?.output_tokens) || 0,
      },
    });
  } catch (err) {
    sendProviderError(res, "describe", err, "식물 설명 서버에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
  }
});

app.use(express.static(path.join(here, "public"), { extensions: ["html"] }));

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") return sendError(res, 400, "bad_request", "이미지가 너무 큽니다.");
  if (err?.type === "entity.parse.failed") return sendError(res, 400, "bad_request", "요청 본문이 올바른 JSON이 아닙니다.");
  console.error(err);
  sendError(res, 502, "upstream_error", "서버 오류가 발생했습니다.");
});

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Garden Lens listening on http://localhost:${PORT} (provider=${PROVIDER_NAME}, model=${MODEL})`);
  });
}

export default app;
