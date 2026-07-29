import { describe, expect, it } from "vitest";

import { readBotConfig } from "./config.js";

describe("readBotConfig", () => {
  it("reads enabled NapCat configuration", () => {
    expect(
      readBotConfig({
        KAGUYA_BOT_DATABASE_PATH: "/tmp/kaguya.sqlite",
        KAGUYA_NAPCAT_ENABLED: "true",
        KAGUYA_NAPCAT_WS_URL: "ws://127.0.0.1:3001",
        KAGUYA_NAPCAT_ACCESS_TOKEN: "secret-token",
        KAGUYA_NAPCAT_SELF_ID: "998877",
        KAGUYA_NAPCAT_RECONNECT_MS: "5000",
      }),
    ).toEqual({
      databasePath: "/tmp/kaguya.sqlite",
      napcat: {
        enabled: true,
        adapterId: "napcat.qq.main",
        wsUrl: "ws://127.0.0.1:3001",
        accessToken: "secret-token",
        selfId: "998877",
        reconnectMs: 5000,
      },
    });
  });

  it("requires ws url when NapCat is enabled", () => {
    expect(() =>
      readBotConfig({ KAGUYA_NAPCAT_ENABLED: "true" }),
    ).toThrow("KAGUYA_NAPCAT_WS_URL is required when KAGUYA_NAPCAT_ENABLED=true");
  });
});
