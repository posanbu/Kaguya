import { describe, expect, it } from "vitest";
import { napCatEndpointLabel } from "./Overview.js";

describe("napCatEndpointLabel", () => {
  it("shows the configured WebSocket protocol and explicit port", () => {
    expect(napCatEndpointLabel("ws://127.0.0.1:3001")).toBe("WS · 3001");
  });

  it("uses the standard secure WebSocket port when omitted", () => {
    expect(napCatEndpointLabel("wss://napcat.example.com")).toBe("WSS · 443");
  });

  it("ignores missing, invalid, and non-WebSocket endpoints", () => {
    expect(napCatEndpointLabel(undefined)).toBeUndefined();
    expect(napCatEndpointLabel("not-a-url")).toBeUndefined();
    expect(napCatEndpointLabel("https://example.com:8443")).toBeUndefined();
  });
});
