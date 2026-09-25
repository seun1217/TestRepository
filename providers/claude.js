// Anthropic SDK 기반 식별 제공자 (docs/CONTRACT.md 3절).
// 1단계(identify)는 구조화 출력(JSON schema)으로 식물 목록을, 2단계(describe)는 식물 하나의 상세 설명을 받는다.
// 거절/한도/파싱 실패는 계약의 오류 코드로 바꾼다. API 키는 이 프로세스의 환경 변수에서만 읽는다.
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-5";
// 비스트리밍 요청 기본값. 사용한 토큰만 과금되므로 상한은 넉넉히 둔다 (adaptive thinking 토큰도 여기에 포함된다).
const MAX_TOKENS = 16000;
const BETAS = ["server-side-fallback-2026-07-01"];
// 타임아웃 정렬 (계약 4절 api.js): 브라우저는 45초에 포기한다. SDK 기본값(10분, 재시도 2회)이면 타임아웃된 호출이
// 사용자가 떠난 뒤에도 재시도되어 과금될 수 있으므로 40초, 재시도 없음으로 둔다. 일시 오류 재시도는 스캐너의 백오프가 맡는다.
const CLIENT_TIMEOUT_MS = 40_000;
const CLIENT_MAX_RETRIES = 0;
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
  no_plant_name: "설명할 식물 이름이 필요합니다.",
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
        required: ["name_ko", "name_sci", "name_en", "family_ko", "confidence", "bbox", "summary_ko", "tags"],
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
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

// 2단계(describe) 스키마. 식물 하나의 상세 설명만 받는다.
export const DESCRIBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["detail_ko"],
  properties: {
    detail_ko: { type: "string" },
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
- summary_ko: exactly ONE sentence for a small tooltip. A longer description is requested in a separate call, so do not add details here.
- tags: 2 to 5 short Korean labels (for example 상록수, 여름꽃, 낙엽관목, 습지식물).

Language: every Korean field (name_ko, family_ko, summary_ko, tags, message_ko) must be written in Korean using polite 존댓말 sentence endings such as "~입니다", "~합니다". Do not use em dashes or en dashes in any text; use commas, periods, or parentheses instead.

Quality rules (the quality field):
- too_dark: the image is too dark to resolve leaves or flowers.
- too_far: plants occupy a very small part of the frame, or details are unresolvable at this distance.
- blurry: motion blur or focus loss prevents identification.
- no_plant: there is no plant in the image.
- ok: otherwise.
When quality is not ok, return an empty plants array and a Korean message_ko (polite form) that tells the visitor what to do: turn on the flash or find brighter light, move closer, hold the camera still, or aim at a plant. When quality is ok, message_ko must be null.`;

export const DESCRIBE_SYSTEM_PROMPT = `You are a botanist assisting visitors of Suncheon Bay National Garden (순천만 국가정원) in Korea. A visitor has tapped one plant that was identified in their phone photo. The user message gives that plant's Korean name, its scientific name when known, and its bounding box in the photo. Write a description of that plant for the visitor and answer only with the required JSON.

Content of detail_ko:
- Two to three short paragraphs separated by blank lines. Keep each paragraph short.
- Cover identification features, flowering or foliage season, habitat or origin, use or cultural notes, and how to tell it apart from similar plants.
- Look at the photo and mention what is visible on this particular plant (flowers, buds, fruit, leaf condition) when it helps the visitor.
- If the named plant is not actually visible at the given box, say so briefly in one sentence and describe the plant that is visible there instead.
- Never invent facts you are unsure of; say that something is uncertain instead.

Language: write detail_ko in Korean using polite 존댓말 sentence endings such as "~입니다", "~합니다". Do not use em dashes or en dashes; use commas, periods, or parentheses instead. Plain paragraphs only, no markdown headings or bullet lists.`;

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

// SDK 클라이언트 옵션. 테스트에서 실제 호출 없이 검증할 수 있도록 따로 노출한다.
export function clientOptions() {
  return { timeout: CLIENT_TIMEOUT_MS, maxRetries: CLIENT_MAX_RETRIES };
}

// 모듈 수준 싱글턴. 첫 호출에서 키를 확인한 뒤에만 만든다.
let client = null;
function getClient() {
  if (client) return client;
  if (!hasCredentials()) throw providerError(401, "no_api_key", MESSAGES.no_api_key, "ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN not set");
  client = new Anthropic(clientOptions());
  return client;
}

function assertMediaType(mediaType) {
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw providerError(400, "bad_request", MESSAGES.bad_media_type, `unsupported media type: ${mediaType}`);
  }
}

function imageBlock(mediaType, imageBase64) {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } };
}

// 요청 본문을 만든다. 순수 함수라 테스트에서 필드를 직접 검증할 수 있다.
// thinking, temperature, tool_choice는 넣지 않는다 (Opus 5는 기본 adaptive thinking, effort로만 조절).
export function buildRequest({ imageBase64, mediaType = "image/jpeg", width, height, lang = "ko" } = {}) {
  assertMediaType(mediaType);
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
        content: [imageBlock(mediaType, imageBase64), { type: "text", text: userText }],
      },
    ],
  };
}

function fmt(v) {
  return String(Math.round(Number(v) * 1000) / 1000);
}

// 2단계 요청 본문 (순수 함수). 같은 이미지에 이름과 bbox를 붙여 그 식물만 설명하게 한다.
export function buildDescribeRequest({ imageBase64, mediaType = "image/jpeg", width, height, lang = "ko", plant } = {}) {
  assertMediaType(mediaType);
  void lang;
  const nameKo = String(plant?.name_ko || "").trim();
  if (!nameKo) throw providerError(400, "bad_request", MESSAGES.no_plant_name, "plant.name_ko is required");
  const nameSci = String(plant?.name_sci || "").trim();
  const b = plant?.bbox;
  const lines = [`This image is ${width}x${height} pixels.`];
  lines.push(`The plant to describe is ${nameKo}${nameSci ? ` (${nameSci})` : ""}.`);
  if (b && typeof b === "object") {
    const px = (v, size) => Math.round(Number(v) * Number(size));
    lines.push(
      `Its bounding box in the image, normalized to 0..1 with x and y at the top-left corner, is x=${fmt(b.x)}, y=${fmt(b.y)}, w=${fmt(b.w)}, h=${fmt(b.h)}` +
        ` (about ${px(b.x, width)},${px(b.y, height)} to ${px(Number(b.x) + Number(b.w), width)},${px(Number(b.y) + Number(b.h), height)} in pixels).`,
    );
  } else {
    lines.push("No bounding box was given; describe the most prominent plant in the image that matches this name.");
  }
  lines.push("Describe this plant for the visitor and answer in the required JSON format.");
  return {
    model: modelName(),
    max_tokens: MAX_TOKENS,
    betas: [...BETAS],
    fallbacks: "default",
    system: [{ type: "text", text: DESCRIBE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: DESCRIBE_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [imageBlock(mediaType, imageBase64), { type: "text", text: lines.join(" ") }],
      },
    ],
  };
}

function stripFences(text) {
  const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : text;
}

// SDK 메시지 객체 -> 파싱된 JSON 객체. 거절/잘림/텍스트 없음/JSON 아님은 계약 오류로 던진다 (두 단계가 공유).
function parseJsonMessage(message) {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw providerError(502, "upstream_error", MESSAGES.unparsable, "model JSON is not an object");
  }
  return parsed;
}

function usageOf(message) {
  return {
    input_tokens: Number(message.usage?.input_tokens) || 0,
    output_tokens: Number(message.usage?.output_tokens) || 0,
  };
}

// SDK 메시지 객체 -> 제공자 응답 (quality, message_ko, plants, model, usage). 실패하면 status/code/message_ko가 있는 오류를 던진다.
export function parseModelResponse(message) {
  const parsed = parseJsonMessage(message);
  if (typeof parsed.quality !== "string") {
    throw providerError(502, "upstream_error", MESSAGES.unparsable, "model JSON has no quality field");
  }
  return {
    quality: parsed.quality,
    message_ko: typeof parsed.message_ko === "string" ? parsed.message_ko : null,
    plants: Array.isArray(parsed.plants) ? parsed.plants : [],
    model: message.model || modelName(),
    usage: usageOf(message),
  };
}

// SDK 메시지 객체 -> { detail_ko, model, usage }. detail_ko가 비어 있으면 502.
export function parseDescribeResponse(message) {
  const parsed = parseJsonMessage(message);
  const detail_ko = typeof parsed.detail_ko === "string" ? parsed.detail_ko.trim() : "";
  if (!detail_ko) throw providerError(502, "upstream_error", MESSAGES.unparsable, "model JSON has no detail_ko");
  return { detail_ko, model: message.model || modelName(), usage: usageOf(message) };
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

async function createMessage(request) {
  const api = getClient();
  try {
    return await api.beta.messages.create(request);
  } catch (err) {
    throw mapSdkError(err);
  }
}

export default async function identify({ imageBase64, mediaType = "image/jpeg", width, height, lang = "ko" } = {}) {
  const request = buildRequest({ imageBase64, mediaType, width, height, lang });
  return parseModelResponse(await createMessage(request));
}

// 2단계: 같은 이미지에서 식물 하나의 상세 설명을 받는다 (계약 3절).
export async function describe({ imageBase64, mediaType = "image/jpeg", width, height, lang = "ko", plant } = {}) {
  const request = buildDescribeRequest({ imageBase64, mediaType, width, height, lang, plant });
  return parseDescribeResponse(await createMessage(request));
}
