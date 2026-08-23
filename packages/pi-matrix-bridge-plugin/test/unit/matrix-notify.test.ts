import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyMatrixUser } from "../../src/server/matrix-notify.js";

describe("notifyMatrixUser (REST)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ room_id: "!room:example.org" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a direct room and sends the text with the Bearer token", async () => {
    const ok = await notifyMatrixUser({
      homeserverUrl: "https://matrix.example.org/",
      accessToken: "syt_token",
      userId: "@alice:example.org",
      text: "✅ Matrix 桥已连接",
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe("https://matrix.example.org/_matrix/client/v3/createRoom");
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(String(createInit.body)).invite).toEqual(["@alice:example.org"]);
    expect(createInit.headers?.Authorization).toBe("Bearer syt_token");

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toContain("/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message");
    expect(JSON.parse(String(sendInit.body)).body).toBe("✅ Matrix 桥已连接");
  });

  it("strips a matrix: transport prefix before inviting", async () => {
    const ok = await notifyMatrixUser({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "t",
      userId: "matrix:@bob:example.org",
      text: "hi",
    });

    expect(ok).toBe(true);
    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(createInit.body)).invite).toEqual(["@bob:example.org"]);
  });

  it("returns false when createRoom fails and never sends", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });

    const ok = await notifyMatrixUser({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "t",
      userId: "@a:example.org",
      text: "hi",
    });

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when the send fails", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ room_id: "!r:example.org" }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const ok = await notifyMatrixUser({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "t",
      userId: "@a:example.org",
      text: "hi",
    });

    expect(ok).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const ok = await notifyMatrixUser({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "t",
      userId: "@a:example.org",
      text: "hi",
    });

    expect(ok).toBe(false);
  });
});