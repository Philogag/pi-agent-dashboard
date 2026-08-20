import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBridgeFile, toBridgeFile, redact } from "../../src/server/mirror.js";
import type { MatrixBridgeConfig } from "../../src/types.js";

const cfg: MatrixBridgeConfig = {
  homeserverUrl: "https://example.org",
  accessToken: "s3cret-token",
  encryption: true,
  autoConnect: true,
  session: { workspace: "/tmp/ws" },
  auth: { trustedUsers: ["@alice:example.org"] },
};

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mirror-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

describe("mirror config to ~/.pi/matrix-bridge.json", () => {
  it("writeBridgeFile creates the file with matrix: prefixed trustedUsers", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await writeBridgeFile(cfg, target);

    const content = await readFile(target, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.auth.trustedUsers[0]).toBe("matrix:@alice:example.org");
  });

  it("writeBridgeFile writes the file with mode 0o600", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "matrix-bridge.json");
    await writeBridgeFile(cfg, target);

    const { mode } = await stat(target);
    // mode includes file-type bits; mask to permission bits
    expect(mode & 0o777).toBe(0o600);
  });

  it("writeBridgeFile auto-creates nested parent directories", async () => {
    const dir = await makeTmpDir();
    const target = join(dir, "nested", "deep", "matrix-bridge.json");
    await writeBridgeFile(cfg, target);

    const content = await readFile(target, "utf8");
    expect(JSON.parse(content).auth.trustedUsers[0]).toBe("matrix:@alice:example.org");
  });

  it("toBridgeFile maps the forward bridge-file shape with matrix: prefix", () => {
    expect(toBridgeFile(cfg)).toEqual({
      homeserverUrl: "https://example.org",
      accessToken: "s3cret-token",
      auth: { trustedUsers: ["matrix:@alice:example.org"] },
    });
  });

  it("redact never leaks the plaintext access token", () => {
    const out = redact(cfg);
    expect(out).toContain("***");
    expect(out).not.toContain("s3cret-token");
  });
});
