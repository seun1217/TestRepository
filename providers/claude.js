// Anthropic SDK 기반 식별 제공자 (docs/CONTRACT.md 3절).
// 구조화 출력(JSON schema)으로 식물 목록을 받고, 거절/한도/파싱 실패를 계약의 오류 코드로 바꾼다.
// API 키는 이 프로세스의 환경 변수에서만 읽는다.
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-5";
// 비스트리밍 요청 기본값. 사용한 토큰만 과금되므로 상한은 넉넉히 둔다 (adaptive thinking 토큰도 여기에 포함된다).
const MAX_TOKENS = 16000;
const BETAS = ["server-side-fallback-2026-07-01"];
const CLIENT_TIMEOUT_MS = 60_000;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// 사용자에게 보이는 문구. 상위 API의 원문 오류는 절대 여기에 섞지 않는다.
export const MESSAGES = {
  no_api_key: "서버에 API 키가 설정되지 않았습니다.",
  bad_api_key: "서버의 API 키가 유효하지 않습니다. 관리자에게 문의해 주세요.",
  rate_limited: "요청이 많아 잠시 기다려야 합니다. 잠시 후 다시 시도해 주세요.",
  connection: "식물 인식 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  upstream: "식물 인식 서버에 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.",
  refused: "이 장면은 분석할 수 없습니다. 다른 식물을 비춰 주세요.",
  truncated: "설명이 너무 길어 응답이 잘렸습니다. 다시 시도해 주세요.",
  unparsable: "모델 응답을 해석하지 못했습니다. 다시 시도해 주세요.",
  bad_media_type: "지원하지 않는 이미지 형식입니다. JPEG, PNG, WebP, GIF만 보낼 수 있습니다.",
};

// 구조화 출력 스키마. 모든 객체는 additionalProperties: false, 모든 키 required.
// 숫자/문자열 길이 제약(minimum, maxLength 등)은 구조화 출력이 지원하지 않으므로 쓰지 않는다.
export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["quality", "message_ko", "plants"],
  properties: {
    quality: { type: "string", enum: ["ok", "too_dark", "too_far", "blurry", "no_plant"] },
    message_ko: { anyOf: [{ type: "string" }, { type: "null" }] },
    plants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name_ko", "name_sci", "name_en", "family_ko", "confidence", "bbox", "summary_ko", "detail_ko", "tags"],
        properties: {
          name_ko: { type: "string" },
          name_sci: { type: "string" },
          name_en: { type: "string" },
          family_ko: { type: "string" },
          confidence: { type: "number" },
          bbox: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "w", "h"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
          },
          summary_ko: { type: "string" },
          detail_ko: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const SYSTEM_PROMPT = `You are a botanist assisting visitors of Suncheon Bay National Garden (순천만 국가정원) in Korea. A visitor points a phone camera at plants; you identify what is clearly visible in the photo and answer only with the required JSON.

Identification rules:
- Identify each distinct plant that is clearly visible. Return one entry per plant individual or clump. Never return duplicate species entries for the same clump.
- Return at most 6 plants, most prominent first (largest or most central first).
- Never invent a species when unsure. Lower the confidence instead, or identify only to the genus level and say so in the text.
- Ornamental garden plants, street trees, wetland plants, and reed beds typical of the Suncheon Bay area are all plausible.

Fields for each plant:
- name_ko: the standard Korean common name (국명).
- name_sci: the scientific binomial (genus and species, Latin).
- name_en: the common English name.
- family_ko: the Korean family name (for example 차나무과, 수국과, 장미과).
- confidence: an honest probability between 0 and 1 that the identification is correct.
- bbox: x, y, w, h normalized to the range 0..1 relative to the full image. x and y are the top-left corner, w and h are the width and height. Keep the box tight around that plant only.
- summary_ko: one or two sentences.
- detail_ko: two to three short paragraphs separated by blank lines. Cover identification features, flowering or foliage season, habitat or origin, use or cultural notes, and how to tell it apart from similar plants. Keep each paragraph short.
- tags: 2 to 5 short Korean labels (for example 상록수, 여름꽃, 낙엽관목, 습지식물).

Language: every Korean field (name_ko, family_ko, summary_ko, detail_ko, tags, message_ko) must be written in Korean using polite 존댓말 sentence endings such as "~입니다", "~합니다". Do not use em dashes or en dashes in any text; use commas, periods, or parentheses instead.

Quality rules (the quality field):
- too_dark: the image is too dark to resolve leaves or flowers.
- too_far: plants occupy a very small part of the frame, or details are unresolvable at this distance.
- blurry: motion blur or focus loss prevents identification.
- no_plant: there is no plant in the image.
- ok: otherwise.
When quality is not ok, return an empty plants array and a Korean message_ko (polite form) that tells the visitor what to do: turn on the flash or find brighter light, move closer, hold the camera still, or aim at a plant. When quality is ok, message_ko must be null.`;

function providerError(status, code, message_ko, detail, cause) {
  const err = new Error(detail || code);
  err.status = status;
  err.code = code;
  err.message_ko = message_ko;
  if (cause) err.cause = cause;
  return err;
}

function modelName() {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// 모듈 수준 싱글턴. 첫 호출에서 키를 확인한 뒤에만 만든다.
let client = null;
function getClient() {
  if (client) return client;
  if (!hasCredentials()) throw providerError(401, "no_api_key", MESSAGES.no_api_key, "ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN not set");
  client = new Anthropic({ timeout: CLIENT_TIMEOUT_MS });
  return client;
}

// 요청 본문을 만든다. 순수 함수라 테스트에서 필드를 직접 검증할 수 있다.
// thinking, temperature, tool_choice는 넣지 않는다 (Opus 5는 기본 adaptive thinking, effort로만 조절).
export function buildRequest({ imageBase64, mediaType = "image/jpeg", width, height, lang = "ko" } = {}) {
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw providerError(400, "bad_request", MESSAGES.bad_media_type, `unsupported media type: ${mediaType}`);
  }
  // lang은 현재 "ko"만 지원한다. 다른 값이 와도 한국어로 답한다 (계약 2절).
  void lang;
  const userText = `This image is ${width}x${height} pixels. Identify the plants clearly visible in it and answer in the required JSON format.`;
  return {
    model: modelName(),
    max_tokens: MAX_TOKENS,
    betas: [...BETAS],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: userText },
        ],
      },
    ],
  };
}

function stripFences(text) {
  const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : text;
}

// SDK 메시지 객체 -> 제공자 응답 (quality, message_ko, plants, model, usage). 실패하면 status/code/message_ko가 있는 오류를 던진다.
export function parseModelResponse(message) {
  if (!message || typeof message !== "object") {
    throw providerError(502, "upstream_error", MESSAGES.upstream, "empty message from API");
  }
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category || "unknown";
    throw providerError(503, "refused", MESSAGES.refused, `model refused (category=${category})`);
  }
  if (message.stop_reason === "max_tokens") {
    throw providerError(502, "upstream_error", MESSAGES.truncated, "response stopped at max_tokens");
  }
  // thinking, fallback 등 다른 블록이 앞에 올 수 있으므로 text 블록만 모은다.
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw providerError(502, "upstream_error", MESSAGES.unparsable, "no text block in response");

  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (err) {
    throw providerError(502, "upstream_error", MESSAGES.unparsable, `invalid JSON from model: ${err.message}`, err);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.quality !== "string") {
    throw providerError(502, "upstream_error", MESSAGES.unparsable, "model JSON has no quality field");
  }
  return {
    quality: parsed.quality,
    message_ko: typeof parsed.message_ko === "string" ? parsed.message_ko : null,
    plants: Array.isArray(parsed.plants) ? parsed.plants : [],
    model: message.model || modelName(),
    usage: {
      input_tokens: Number(message.usage?.input_tokens) || 0,
      output_tokens: Number(message.usage?.output_tokens) || 0,
    },
  };
}

// SDK 오류 -> 계약 오류. instanceof는 구체적인 것부터 (APIConnectionError도 APIError의 하위 클래스).
export function mapSdkError(err) {
  if (err && err.status && err.code && err.message_ko) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return providerError(401, "no_api_key", MESSAGES.bad_api_key, `authentication failed (${err.status})`, err);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return providerError(429, "rate_limited", MESSAGES.rate_limited, `upstream rate limit (${err.status})`, err);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return providerError(502, "upstream_error", MESSAGES.connection, `connection error: ${err.message}`, err);
  }
  if (err instanceof Anthropic.APIError) {
    return providerError(502, "upstream_error", MESSAGES.upstream, `api error ${err.status ?? "?"}: ${err.message}`, err);
  }
  return providerError(502, "upstream_error", MESSAGES.upstream, err?.message || "unknown provider error", err);
}

export default async function identify({ imageBase64, mediaType = "image/jpeg", width, height, lang = "ko" } = {}) {
  const api = getClient();
  const request = buildRequest({ imageBase64, mediaType, width, height, lang });
  let message;
  try {
    message = await api.beta.messages.create(request);
  } catch (err) {
    throw mapSdkError(err);
  }
  return parseModelResponse(message);
}
