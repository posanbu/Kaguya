/** Explicit public projection: connection settings and raw errors never enter this schema. */
const lifecycle = {
  type: "string",
  enum: ["disabled", "starting", "running", "stopping", "stopped", "failed"],
};
const ingress = {
  type: "string",
  enum: ["ready", "runtime_unavailable", "stopping"],
};
export const adapterStatusResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["adapterHostState", "runtime", "adapters"],
      properties: {
        adapterHostState: lifecycle,
        runtime: {
          type: "object",
          additionalProperties: false,
          required: ["ingress"],
          properties: {
            ingress,
            reason: {
              type: "string",
              enum: [
                "configuration_not_ready",
                "database_unavailable",
                "runtime_start_failed",
              ],
            },
          },
        },
        adapters: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "adapterId",
              "type",
              "platform",
              "enabled",
              "lifecycle",
              "connectivity",
              "ingress",
              "updatedAt",
            ],
            properties: {
              adapterId: { type: "string" },
              type: { type: "string" },
              platform: { type: "string" },
              enabled: { type: "boolean" },
              lifecycle,
              ingress,
              connectivity: {
                type: "string",
                enum: [
                  "not_applicable",
                  "connecting",
                  "connected",
                  "retrying",
                  "disconnected",
                ],
              },
              updatedAt: { type: "string", format: "date-time" },
              attempt: { type: "integer", minimum: 1 },
              nextRetryAt: { type: "string", format: "date-time" },
              errorType: {
                type: "string",
                enum: [
                  "configuration_invalid",
                  "connection_failed",
                  "start_failed",
                  "stop_failed",
                ],
              },
            },
          },
        },
      },
    },
  },
} as const;
