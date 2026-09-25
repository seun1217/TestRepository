// providers/claude.js 단위 테스트. 실제 API는 절대 호출하지 않는다 (키 없음 -> 클라이언트를 만들기 전에 401).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.CLAUDE_MODEL;

const {
  default: identify,
  describe: describePlant,
  parseModelResponse,
  parseDescribeResponse,
  buildRequest,
  buildDescribeRequest,
  clientOptions,
  mapSdkError,
  OUTPUT_SCHEMA,
  DESCRIBE_SCHEMA,
  SYSTEM_PROMPT,
  DESCRIBE_SYSTEM_PROMPT,
  MESSAGES,
} = await import("../../providers/claude.js");

const KOREAN = /[가-힣]/;
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const input = { imageBase64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==", mediaType: "image/jpeg", width: 1024, height: 768, lang: "ko" };

const GOOD_JSON = {
  quality: "ok",
  message_ko: null,
  plants: [
    {
      name_ko: "동백나무",
      name_sci: "Camellia japonica",
      name_en: "Japanese camellia",
      family_ko: "차나무과",
      confidence: 0.86,
      bbox: { x: 0.12, y: 0.2, w: 0.35, h: 0.5 },
      summary_ko: "겨울에 붉은 꽃이 피는 상록수입니다.",
      tags: ["상록수", "겨울꽃"],
    },
  ],
};

const GOOD_DETAIL = "잎은 두껍고 광택이 있습니다.\n\n남해안에 자생합니다.";
const plantInput = { id: "p1", name_ko: "동백나무", name_sci: "Camellia japonica", bbox: { x: 0.12, y: 0.2, w: 0.35, h: 0.5 } };

function fakeMessage(over = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: JSON.stringify(GOOD_JSON), citations: null },
    ],
    usage: { input_tokens: 1234, output_tokens: 567 },
    ...over,
  };
}

describe("identify without credentials", () => {
  test("throws 401 no_api_key before touching the SDK", async () => {
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
    await assert.rejects(identify(input), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.code, "no_api_key");
      assert.equal(err.message_ko, "서버에 API 키가 설정되지 않았습니다.");
      return true;
    });
  });

  test("describe also throws 401 no_api_key before touching the SDK", async () => {
    await assert.rejects(describePlant({ ...input, plant: plantInput }), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.code, "no_api_key");
      return true;
    });
  });
});

describe("clientOptions", () => {
  test("aligns with the browser timeout: 40 s and no SDK retries", () => {
    assert.deepEqual(clientOptions(), { timeout: 40_000, maxRetries: 0 });
  });

  test("the SDK accepts the options as given (constructing a client makes no request)", () => {
    const client = new Anthropic({ apiKey: "test-key-never-used", ...clientOptions() });
    assert.equal(client.timeout, 40_000);
    assert.equal(client.maxRetries, 0);
  });
});

describe("buildRequest", () => {
  test("matches the contract request shape and passes no thinking/temperature/tool_choice", () => {
    const req = buildRequest(input);
    assert.equal(req.model, "claude-opus-5");
    assert.equal(req.max_tokens, 16000);
    assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(req.fallbacks, "default");
    assert.equal(req.system.length, 1);
    assert.equal(req.system[0].type, "text");
    assert.equal(req.system[0].text, SYSTEM_PROMPT);
    assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
    assert.equal(req.output_config.effort, "medium");
    assert.equal(req.output_config.format.type, "json_schema");
    assert.equal(req.output_config.format.schema, OUTPUT_SCHEMA);
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    const [image, text] = req.messages[0].content;
    assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.imageBase64 } });
    assert.equal(text.type, "text");
    assert.match(text.text, /1024x768/);
    for (const forbidden of ["thinking", "temperature", "tool_choice", "tools", "output_format", "stream"]) {
      assert.equal(forbidden in req, false, `${forbidden} must not be sent`);
    }
  });

  test("honors CLAUDE_MODEL", () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-5";
    try {
      assert.equal(buildRequest(input).model, "claude-sonnet-5");
    } finally {
      delete process.env.CLAUDE_MODEL;
    }
  });

  test("rejects an unsupported media type with 400 bad_request", () => {
    assert.throws(() => buildRequest({ ...input, mediaType: "image/bmp" }), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, "bad_request");
      assert.match(err.message_ko, KOREAN);
      return true;
    });
  });
});

describe("buildDescribeRequest", () => {
  test("matches the stage 2 request shape: same model, betas, fallbacks, cached describe prompt, describe schema", () => {
    const req = buildDescribeRequest({ ...input, plant: plantInput });
    assert.equal(req.model, "claude-opus-5");
    assert.equal(req.max_tokens, 16000);
    assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(req.fallbacks, "default");
    assert.equal(req.system.length, 1);
    assert.equal(req.system[0].type, "text");
    assert.equal(req.system[0].text, DESCRIBE_SYSTEM_PROMPT);
    assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
    assert.equal(req.output_config.effort, "medium");
    assert.equal(req.output_config.format.type, "json_schema");
    assert.equal(req.output_config.format.schema, DESCRIBE_SCHEMA);
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    const [image, text] = req.messages[0].content;
    assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.imageBase64 } });
    assert.equal(text.type, "text");
    assert.match(text.text, /1024x768/);
    assert.match(text.text, /동백나무/);
    assert.match(text.text, /Camellia japonica/);
    assert.match(text.text, /x=0\.12/);
    assert.match(text.text, /y=0\.2\b/);
    assert.match(text.text, /w=0\.35/);
    assert.match(text.text, /h=0\.5\b/);
    for (const forbidden of ["thinking", "temperature", "tool_choice", "tools", "output_format", "stream"]) {
      assert.equal(forbidden in req, false, `${forbidden} must not be sent`);
    }
  });

  test("keeps the image block identical to the stage 1 request", () => {
    const stage1 = buildRequest(input).messages[0].content[0];
    const stage2 = buildDescribeRequest({ ...input, plant: plantInput }).messages[0].content[0];
    assert.deepEqual(stage2, stage1);
  });

  test("passes a PNG media type through to the image block", () => {
    const req = buildDescribeRequest({ ...input, mediaType: "image/png", plant: plantInput });
    assert.equal(req.messages[0].content[0].source.media_type, "image/png");
  });

  test("works without name_sci and bbox and says the box is missing", () => {
    const req = buildDescribeRequest({ ...input, plant: { name_ko: "수국" } });
    const text = req.messages[0].content[1].text;
    assert.match(text, /수국/);
    assert.doesNotMatch(text, /x=/);
    assert.match(text, /No bounding box/);
  });

  test("honors CLAUDE_MODEL", () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-5";
    try {
      assert.equal(buildDescribeRequest({ ...input, plant: plantInput }).model, "claude-sonnet-5");
    } finally {
      delete process.env.CLAUDE_MODEL;
    }
  });

  test("rejects a missing plant name with 400 bad_request", () => {
    for (const plant of [undefined, {}, { name_ko: "  " }]) {
      assert.throws(() => buildDescribeRequest({ ...input, plant }), (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, "bad_request");
        assert.match(err.message_ko, KOREAN);
        return true;
      });
    }
  });

  test("rejects an unsupported media type with 400 bad_request", () => {
    assert.throws(() => buildDescribeRequest({ ...input, mediaType: "image/bmp", plant: plantInput }), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, "bad_request");
      return true;
    });
  });
});

function walkSchema(node, visit, path = "$") {
  if (!node || typeof node !== "object") return;
  visit(node, path);
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) v.forEach((item, i) => walkSchema(item, visit, `${path}.${k}[${i}]`));
    else if (v && typeof v === "object") walkSchema(v, visit, `${path}.${k}`);
  }
}

function assertStructuredOutputSafe(schema) {
  walkSchema(schema, (node, path) => {
    for (const bad of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "multipleOf"]) {
      assert.equal(bad in node, false, `${bad} at ${path}`);
    }
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `additionalProperties at ${path}`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `required at ${path}`);
    }
  });
}

describe("OUTPUT_SCHEMA", () => {
  test("uses only constraints structured outputs support, every object closed and fully required", () => {
    assertStructuredOutputSafe(OUTPUT_SCHEMA);
  });

  test("declares the contract fields without detail_ko (stage 1 is tooltip data only)", () => {
    const p = OUTPUT_SCHEMA.properties;
    assert.deepEqual(p.quality.enum, ["ok", "too_dark", "too_far", "blurry", "no_plant"]);
    assert.deepEqual(p.message_ko, { anyOf: [{ type: "string" }, { type: "null" }] });
    const plant = p.plants.items.properties;
    assert.deepEqual(Object.keys(plant), ["name_ko", "name_sci", "name_en", "family_ko", "confidence", "bbox", "summary_ko", "tags"]);
    assert.equal("detail_ko" in plant, false);
    assert.equal(p.plants.items.required.includes("detail_ko"), false);
    assert.equal(plant.confidence.type, "number");
    assert.deepEqual(Object.keys(plant.bbox.properties), ["x", "y", "w", "h"]);
    assert.equal(plant.tags.items.type, "string");
  });

  test("the stage 1 prompt no longer asks for detail_ko and wants a one-sentence summary", () => {
    assert.doesNotMatch(SYSTEM_PROMPT, /detail_ko/);
    assert.match(SYSTEM_PROMPT, /summary_ko: exactly ONE sentence/);
    assert.match(SYSTEM_PROMPT, /separate call/);
  });
});

describe("DESCRIBE_SCHEMA", () => {
  test("is a closed object with only a required detail_ko string", () => {
    assertStructuredOutputSafe(DESCRIBE_SCHEMA);
    assert.deepEqual(DESCRIBE_SCHEMA, {
      type: "object",
      additionalProperties: false,
      required: ["detail_ko"],
      properties: { detail_ko: { type: "string" } },
    });
  });
});

describe("parseModelResponse", () => {
  test("returns the provider shape from a text block that follows a thinking block", () => {
    const out = parseModelResponse(fakeMessage());
    assert.equal(out.quality, "ok");
    assert.equal(out.message_ko, null);
    assert.equal(out.plants.length, 1);
    assert.equal(out.plants[0].name_ko, "동백나무");
    assert.deepEqual(out.plants[0].bbox, { x: 0.12, y: 0.2, w: 0.35, h: 0.5 });
    assert.equal(out.model, "claude-opus-5");
    assert.deepEqual(out.usage, { input_tokens: 1234, output_tokens: 567 });
  });

  test("tolerates a fallback block and reports the model that answered", () => {
    const msg = fakeMessage({
      model: "claude-opus-4-8",
      content: [
        { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
        { type: "text", text: JSON.stringify({ ...GOOD_JSON, quality: "too_far", message_ko: "더 가까이 가 주세요.", plants: [] }) },
      ],
    });
    const out = parseModelResponse(msg);
    assert.equal(out.model, "claude-opus-4-8");
    assert.equal(out.quality, "too_far");
    assert.equal(out.message_ko, "더 가까이 가 주세요.");
    assert.deepEqual(out.plants, []);
  });

  test("refusal stop_reason -> 503 refused with a Korean message", () => {
    assert.throws(() => parseModelResponse(fakeMessage({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" }, content: [] })), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, "refused");
      assert.match(err.message_ko, KOREAN);
      return true;
    });
  });

  test("max_tokens stop_reason -> 502 upstream_error", () => {
    assert.throws(() => parseModelResponse(fakeMessage({ stop_reason: "max_tokens" })), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, "upstream_error");
      assert.match(err.message_ko, KOREAN);
      return true;
    });
  });

  test("invalid JSON -> 502 upstream_error and the raw text is not leaked into message_ko", () => {
    const junk = "RAW_MODEL_JUNK {not json";
    assert.throws(() => parseModelResponse(fakeMessage({ content: [{ type: "text", text: junk }] })), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, "upstream_error");
      assert.match(err.message_ko, KOREAN);
      assert.equal(err.message_ko.includes("RAW_MODEL_JUNK"), false);
      return true;
    });
  });

  test("no text block -> 502 upstream_error", () => {
    assert.throws(() => parseModelResponse(fakeMessage({ content: [{ type: "thinking", thinking: "", signature: "s" }] })), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, "upstream_error");
      return true;
    });
  });

  test("JSON without a quality field -> 502", () => {
    assert.throws(() => parseModelResponse(fakeMessage({ content: [{ type: "text", text: JSON.stringify({ plants: [] }) }] })), (err) => {
      assert.equal(err.status, 502);
      return true;
    });
  });

  test("accepts JSON wrapped in a code fence and fills missing usage with zeros", () => {
    const out = parseModelResponse(fakeMessage({ usage: undefined, content: [{ type: "text", text: "```json\n" + JSON.stringify(GOOD_JSON) + "\n```" }] }));
    assert.equal(out.quality, "ok");
    assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
  });
});

describe("parseDescribeResponse", () => {
  const detailMessage = (over = {}) => fakeMessage({ content: [{ type: "text", text: JSON.stringify({ detail_ko: GOOD_DETAIL }) }], ...over });

  test("returns detail_ko, the answering model and usage", () => {
    const out = parseDescribeResponse(detailMessage());
    assert.deepEqual(out, { detail_ko: GOOD_DETAIL, model: "claude-opus-5", usage: { input_tokens: 1234, output_tokens: 567 } });
  });

  test("trims whitespace, skips thinking blocks and accepts a code fence", () => {
    const out = parseDescribeResponse(
      fakeMessage({
        usage: undefined,
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "```json\n" + JSON.stringify({ detail_ko: `  ${GOOD_DETAIL}\n` }) + "\n```" },
        ],
      }),
    );
    assert.equal(out.detail_ko, GOOD_DETAIL);
    assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
  });

  test("refusal stop_reason -> 503 refused with a Korean message", () => {
    assert.throws(() => parseDescribeResponse(detailMessage({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" }, content: [] })), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, "refused");
      assert.match(err.message_ko, KOREAN);
      return true;
    });
  });

  test("max_tokens stop_reason -> 502 upstream_error", () => {
    assert.throws(() => parseDescribeResponse(detailMessage({ stop_reason: "max_tokens" })), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, "upstream_error");
      return true;
    });
  });

  test("empty or missing detail_ko -> 502 upstream_error with the unparsable message", () => {
    for (const body of [{ detail_ko: "" }, { detail_ko: "   " }, { detail_ko: null }, { plants: [] }]) {
      assert.throws(() => parseDescribeResponse(fakeMessage({ content: [{ type: "text", text: JSON.stringify(body) }] })), (err) => {
        assert.equal(err.status, 502, JSON.stringify(body));
        assert.equal(err.code, "upstream_error");
        assert.equal(err.message_ko, MESSAGES.unparsable);
        return true;
      });
    }
  });

  test("invalid JSON or no text block -> 502 upstream_error without leaking raw text", () => {
    const junk = "RAW_MODEL_JUNK {not json";
    assert.throws(() => parseDescribeResponse(fakeMessage({ content: [{ type: "text", text: junk }] })), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, "upstream_error");
      assert.equal(err.message_ko.includes("RAW_MODEL_JUNK"), false);
      return true;
    });
    assert.throws(() => parseDescribeResponse(fakeMessage({ content: [] })), (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.code, "upstream_error");
      return true;
    });
  });
});

describe("mapSdkError", () => {
  const headers = new Headers();
  const secret = "SECRET_UPSTREAM_TEXT";

  test("AuthenticationError -> 401 no_api_key", () => {
    const err = mapSdkError(new Anthropic.AuthenticationError(401, { error: { type: "authentication_error", message: secret } }, secret, headers));
    assert.equal(err.status, 401);
    assert.equal(err.code, "no_api_key");
    assert.match(err.message_ko, KOREAN);
    assert.equal(err.message_ko.includes(secret), false);
  });

  test("RateLimitError -> 429 rate_limited", () => {
    const err = mapSdkError(new Anthropic.RateLimitError(429, { error: { type: "rate_limit_error", message: secret } }, secret, headers));
    assert.equal(err.status, 429);
    assert.equal(err.code, "rate_limited");
    assert.equal(err.message_ko.includes(secret), false);
  });

  test("APIConnectionError -> 502 upstream_error", () => {
    const err = mapSdkError(new Anthropic.APIConnectionError({ message: secret }));
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_error");
    assert.equal(err.message_ko.includes(secret), false);
  });

  test("other APIError (529 overloaded) -> 502 upstream_error", () => {
    const err = mapSdkError(new Anthropic.InternalServerError(529, { error: { type: "overloaded_error", message: secret } }, secret, headers));
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_error");
    assert.equal(err.message_ko.includes(secret), false);
  });

  test("unknown error -> 502 with a generic Korean message", () => {
    const err = mapSdkError(new TypeError("boom"));
    assert.equal(err.status, 502);
    assert.equal(err.code, "upstream_error");
    assert.match(err.message_ko, KOREAN);
  });

  test("already-mapped errors pass through unchanged", () => {
    const own = Object.assign(new Error("x"), { status: 503, code: "refused", message_ko: "거절되었습니다." });
    assert.equal(mapSdkError(own), own);
  });
});

describe("style rules", () => {
  test("no em/en dashes in the prompts or user-facing messages", () => {
    assert.doesNotMatch(SYSTEM_PROMPT, DASH);
    assert.doesNotMatch(DESCRIBE_SYSTEM_PROMPT, DASH);
    assert.match(DESCRIBE_SYSTEM_PROMPT, /존댓말/);
    assert.match(DESCRIBE_SYSTEM_PROMPT, /paragraphs separated by blank lines/);
    for (const m of Object.values(MESSAGES)) {
      assert.doesNotMatch(m, DASH);
      assert.match(m, /(?:니다|주세요)\.$/);
    }
  });
});
