// 자동 스캔 루프. docs/CONTRACT.md 4절 scanner.js. 구현은 워크플로우 에이전트가 채운다.
export function createScanner(options) {
  return { start() {}, stop() {}, scanNow() {}, isRunning() { return false; } };
}
