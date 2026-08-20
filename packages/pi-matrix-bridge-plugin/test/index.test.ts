/**
 * Pi Matrix Bridge — starter tests.
 * Replace with real assertions as you implement each claim.
 */
import { describe, it, expect } from "vitest";
import pkg from "../package.json" with { type: "json" };

describe("@blackbelt-technology/pi-matrix-bridge-plugin manifest", () => {
  it("declares pi-dashboard-plugin field", () => {
    expect((pkg as Record<string, unknown>)["pi-dashboard-plugin"]).toBeDefined();
  });

  it("manifest id matches expected", () => {
    const manifest = (pkg as Record<string, unknown>)["pi-dashboard-plugin"] as { id: string };
    expect(manifest.id).toBe("pi-matrix-bridge");
  });

  it("declares at least one claim", () => {
    const manifest = (pkg as Record<string, unknown>)["pi-dashboard-plugin"] as { claims: unknown[] };
    expect(Array.isArray(manifest.claims)).toBe(true);
    expect(manifest.claims.length).toBeGreaterThan(0);
  });

  it("declares requiredApi", () => {
    const manifest = (pkg as Record<string, unknown>)["pi-dashboard-plugin"] as { requiredApi: string };
    expect(typeof manifest.requiredApi).toBe("string");
    expect(manifest.requiredApi.length).toBeGreaterThan(0);
  });
});
