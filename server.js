// Garden Lens 서버: 정적 파일 서빙 + 비전 모델 프록시.
// API 키는 이 프로세스에만 존재하며 브라우저로 전달되지 않는다.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PROVIDER_NAME = (process.env.IDENTIFY_PROVIDER || "claude").toLowerCase();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_CONFIDENCE = 0.35;
const MAX_PLANTS = 6;

const QUALITY_MESSAGES = {
  too_dark: "너무 어둡습니다. 플래시를 켜거나 더 밝은 곳에서 비춰 주세요.",
  too_far: "식물이 너무 멀리 있습니다. 더 가까이 다가가 주세요.",
  blurry: "화면이 흔들립니다. 카메라를 잠시 고정해 주세요.",
  no_plant: "화면에서 식물을 찾지 못했습니다. 식물이 화면 가운데 오도록 비춰 주세요.",
};

async function loadProvider(name) {
  const mod = await import(`./providers/${name === "mock" ? "mock" : "claude"}.js`);
  return mod.default;
}

const identifyWithProvider = await loadProvider(PROVIDER_NAME);

const app = express();
app.disable("x-powered-by");
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
      const b = p?.bbox || {};
      const x = clamp01(b.x);
      const y = clamp01(b.y);
      return {
        id: "",
        name_ko: String(p?.name_ko || "").trim() || "이름 미상",
        name_sci: String(p?.name_sci || "").trim(),
        name_en: String(p?.name_en || "").trim(),
        family_ko: String(p?.family_ko || "").trim(),
        confidence: clamp01(p?.confidence),
        bbox: { x, y, w: Math.min(clamp01(b.w), 1 - x), h: Math.min(clamp01(b.h), 1 - y) },
        summary_ko: String(p?.summary_ko || "").trim(),
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

app.post("/api/identify", async (req, res) => {
  const body = req.body || {};
  let image = typeof body.image === "string" ? body.image.trim() : "";
  const dataUrlMatch = image.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
  let mediaType = "image/jpeg";
  if (dataUrlMatch) {
    mediaType = dataUrlMatch[1];
    image = dataUrlMatch[2];
  }
  image = image.replace(/\s+/g, "");
  if (!image) return sendError(res, 400, "bad_request", "이미지가 비어 있습니다.");
  if (!BASE64_RE.test(image)) return sendError(res, 400, "bad_request", "이미지 형식이 올바르지 않습니다.");
  if (image.length * 0.75 > MAX_IMAGE_BYTES) return sendError(res, 400, "bad_request", "이미지가 너무 큽니다.");
  const width = Number.parseInt(body.width, 10);
  const height = Number.parseInt(body.height, 10);
  if (!(width > 0 && height > 0)) return sendError(res, 400, "bad_request", "이미지 크기 정보가 필요합니다.");
  const lang = body.lang === "ko" || body.lang == null ? "ko" : String(body.lang);

  try {
    const raw = await identifyWithProvider({
      imageBase64: image,
      mediaType,
      width,
      height,
      lang,
      debug: PROVIDER_NAME === "mock" ? body.debug : undefined,
    });
    res.json(normalizeResponse(raw, MODEL));
  } catch (err) {
    const status = err?.status || 502;
    const code = err?.code || (status === 401 ? "no_api_key" : status === 429 ? "rate_limited" : status === 503 ? "refused" : "upstream_error");
    const message_ko = err?.message_ko || "식물 인식 서버에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.";
    if (status >= 500) console.error("[identify] failed:", err?.message || err);
    sendError(res, [400, 401, 429, 502, 503].includes(status) ? status : 502, code, message_ko);
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
