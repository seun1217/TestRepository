import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

// 이 환경에는 Chromium이 미리 설치되어 있다. 경로가 있으면 그 바이너리를 쓴다.
const PREINSTALLED = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM_PATH || (fs.existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3456",
    ...devices["Pixel 7"],
    permissions: ["camera"],
    launchOptions: {
      executablePath,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: {
    command: "IDENTIFY_PROVIDER=mock PORT=3456 node server.js",
    url: "http://127.0.0.1:3456/api/health",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
