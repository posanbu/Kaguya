import { describe, expect, it } from "vitest";

import { defaultServerConfig, readConfigRoot } from "./config.js";

describe("server bootstrap configuration", () => {
  it("uses the fixed default profile root", () => {
    expect(readConfigRoot({})).toMatch(
      /[/\\]\.data[/\\]kaguya-config$/u,
    );
  });

  it("allows only the profile root locator to be overridden", () => {
    expect(
      readConfigRoot({
        KAGUYA_CONFIG_ROOT: "  /tmp/kaguya-profile  ",
        KAGUYA_PORT: "7897",
        KAGUYA_NAPCAT_WS_URL: "ws://ignored",
      }),
    ).toBe("/tmp/kaguya-profile");
  });

  it("keeps service defaults outside the environment parser", () => {
    expect(defaultServerConfig()).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      napcat: { enabled: false },
    });
  });
});
