import { describe, expect, it } from "vitest";

import {
  createGatewayAuthenticator,
  type GatewayScope,
} from "./gateway-auth.js";

describe("gateway authentication", () => {
  it("grants the startup token every gateway scope", async () => {
    const auth = createGatewayAuthenticator("startup-token");
    const scopes: GatewayScope[] = ["management", "messages"];

    await expect(
      Promise.all(
        scopes.map((scope) => auth.authorize("startup-token", scope)),
      ),
    ).resolves.toEqual([true, true]);
    await expect(
      auth.authorize("previous-start-token", "management"),
    ).resolves.toBe(false);
  });
});
