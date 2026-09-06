import { z } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import {
  defineInformationKind,
  defineInformationModule,
  onInformation,
  onTargetedInformation,
} from "./index.js";

const inputKind = defineInformationKind({
  kind: "acme.sdk.input",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

describe("information module SDK", () => {
  it("defines broadcast and targeted subscriptions", () => {
    expect(onInformation(inputKind, () => undefined)).toMatchObject({
      kind: inputKind.kind,
      targeted: false,
    });
    expect(onTargetedInformation(inputKind, () => undefined)).toMatchObject({
      kind: inputKind.kind,
      targeted: true,
    });
  });

  it("rejects duplicate declared kinds", () => {
    expect(() =>
      defineInformationModule({
        manifest: {
          apiVersion: 1,
          definitionId: "acme.duplicate",
          displayName: "Duplicate",
          settingsSchema: z.object({}).strict(),
          informationKinds: [inputKind, inputKind],
        },
        create: () => ({ subscriptions: [] }),
      }),
    ).toThrow(`Duplicate information module kind: ${inputKind.kind}`);
  });
});
