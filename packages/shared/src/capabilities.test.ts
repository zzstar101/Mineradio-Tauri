import { expect, test } from "bun:test";
import { CapabilityMatrixSchema } from "./capabilities";

test("capability matrix parses well-formed payload", () => {
  const parsed = CapabilityMatrixSchema.parse({
    version: "0.1.0",
    providers: [
      {
        providerId: "netease",
        registered: true,
        configured: true,
        available: false,
        fieldVerified: false,
        capabilities: ["search", "songUrl", "lyric"]
      }
    ],
    services: [{
      serviceId: "weatherRadio",
      registered: true,
      configured: true,
      available: false,
      fieldVerified: false
    }]
  });
  expect(parsed.providers[0].providerId).toBe("netease");
  expect(parsed.providers[0].available).toBe(false);
  expect(parsed.services[0].fieldVerified).toBe(false);
});

test("capability matrix does not infer operational evidence from adapter presence", () => {
  const result = CapabilityMatrixSchema.safeParse({
    version: "0.1.0",
    providers: [{
      providerId: "netease",
      capabilities: ["search"]
    }]
  });
  expect(result.success).toBe(false);
});

test("capability matrix rejects unknown capability value", () => {
  expect(() =>
    CapabilityMatrixSchema.parse({
      version: "0.1.0",
      providers: [
        {
          providerId: "qq",
          registered: true,
          configured: true,
          available: false,
          fieldVerified: false,
          capabilities: ["telepathy"]
        }
      ]
    })
  ).toThrow();
});