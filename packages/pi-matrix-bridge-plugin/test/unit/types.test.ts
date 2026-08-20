import { describe, it, expect } from "vitest";
import { isUserMatrixId, matrixUserId, EMPTY_CONFIG } from "../../src/types.js";

describe("shared config types", () => {
  it("isUserMatrixId accepts a valid matrix user id", () => {
    expect(isUserMatrixId("@alice:example.org")).toBe(true);
  });

  it("isUserMatrixId rejects a non-user string", () => {
    expect(isUserMatrixId("not-a-user")).toBe(false);
  });

  it("matrixUserId prefixes with matrix:", () => {
    expect(matrixUserId("@alice:example.org")).toBe("matrix:@alice:example.org");
  });

  it("EMPTY_CONFIG carries expected defaults", () => {
    expect(EMPTY_CONFIG).toEqual({
      homeserverUrl: "",
      accessToken: "",
      encryption: true,
      autoConnect: true,
      session: { workspace: "" },
      auth: { trustedUsers: [] },
    });
  });
});
