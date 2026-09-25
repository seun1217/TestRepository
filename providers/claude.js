// Anthropic SDK 기반 식별 제공자. 구현은 워크플로우 에이전트가 채운다 (docs/CONTRACT.md 3절).
export default async function identify() {
  const err = new Error("providers/claude.js is not implemented yet");
  err.status = 502;
  err.code = "upstream_error";
  err.message_ko = "식물 인식 제공자가 아직 구성되지 않았습니다.";
  throw err;
}
