import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BridgeConfigError,
  type BridgeFileJson,
  flattenBridgeFile,
  readBridgeFile,
  stripMatrixPrefix,
  writeBridgeConfig,
} from "../../src/server/bridge-file.js";

let tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-file-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

const input = {
  homeserverUrl: "https://example.org",
  accessToken: "s3cret-token",
  trustedUsers: ["@alice:example.org"],
};

describe("bridge-file adapter (~/.pi/matrix-bridge.json)", () => {
  it("readBridgeFile parses the native nested schema", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await writeFile(
      target,
      JSON.stringify({
        matrix: { homeserverUrl: "https://example.org", accessToken: "s3cret-token" },
        auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
      }),
      "utf8",
    );
    const file = await readBridgeFile(target);
    expect(file).toEqual({
      matrix: { homeserverUrl: "https://example.org", accessToken: "s3cret-token" },
      auth: { trustedUsers: ["matrix:@alice:example.org"], channels: { "!room:server": "allow" } },
    });
  });

  it("readBridgeFile returns null for missing / broken / invalid files", async () => {
    expect(await readBridgeFile("/nonexistent/definitely-missing.json")).toBeNull();
    const dir = await makeTmpDir();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json", "utf8");
    expect(await readBridgeFile(bad)).toBeNull();
    const noMatrix = join(dir, "nomatrix.json");
    await writeFile(noMatrix, JSON.stringify({ auth: { trustedUsers: [] } }), "utf8");
    expect(await readBridgeFile(noMatrix)).toBeNull();
  });

  it("stripMatrixPrefix strips only the matrix: namespace prefix", () => {
    expect(stripMatrixPrefix("matrix:@alice:example.org")).toBe("@alice:example.org");
    expect(stripMatrixPrefix("@bob:example.org")).toBe("@bob:example.org");
  });

  it("flattenBridgeFile flattens matrix.* and strips prefixes; null → empty defaults", () => {
    const file: BridgeFileJson = {
      matrix: { homeserverUrl: "https://example.org", accessToken: "s3cret-token" },
      auth: { trustedUsers: ["matrix:@alice:example.org", "@raw:other.org"], channels: {} },
    };
    expect(flattenBridgeFile(file)).toEqual({
      homeserverUrl: "https://example.org",
      accessToken: "s3cret-token",
      trustedUsers: ["@alice:example.org", "@raw:other.org"],
    });
    expect(flattenBridgeFile(null)).toEqual({ homeserverUrl: "", accessToken: "", trustedUsers: [] });
  });

  it("writeBridgeConfig writes nested matrix.* with matrix: prefixed users and mode 0o600", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    const written = await writeBridgeConfig(input, target);
    expect(written.matrix).toEqual({ homeserverUrl: "https://example.org", accessToken: "s3cret-token" });
    const parsed = JSON.parse(await readFile(target, "utf8"));
    expect(parsed.matrix).toEqual({ homeserverUrl: "https://example.org", accessToken: "s3cret-token" });
    expect(parsed.auth.trustedUsers).toEqual(["matrix:@alice:example.org"]);
    const { mode } = await stat(target);
    expect(mode & 0o777).toBe(0o600);
  });

  it("writeBridgeConfig preserves existing auth.channels (read-modify-write)", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await writeFile(
      target,
      JSON.stringify({
        matrix: { homeserverUrl: "https://old.example.org", accessToken: "old-token" },
        auth: { trustedUsers: ["matrix:@bob:example.org"], channels: { "!room:server": "allow" } },
      }),
      "utf8",
    );
    await writeBridgeConfig(input, target);
    const parsed = JSON.parse(await readFile(target, "utf8"));
    expect(parsed.matrix).toEqual({ homeserverUrl: "https://example.org", accessToken: "s3cret-token" });
    expect(parsed.auth.channels).toEqual({ "!room:server": "allow" });
  });

  it("writeBridgeConfig auto-creates nested parent directories", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "nested", "deep", "matrix-bridge.json");
    await writeBridgeConfig(input, target);
    expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
  });

  it("writeBridgeConfig throws BridgeConfigError when no file and no connection (E10)", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await expect(
      writeBridgeConfig({ homeserverUrl: "", accessToken: "", trustedUsers: [] }, target),
    ).rejects.toBeInstanceOf(BridgeConfigError);
  });
});