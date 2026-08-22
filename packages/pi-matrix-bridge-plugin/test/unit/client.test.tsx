// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Settings } from "../../src/client.js";

afterEach(cleanup);

// Mock the plugin runtime context hooks.
const contextMock = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  send: vi.fn(),
}));
vi.mock("@blackbelt-technology/dashboard-plugin-runtime/context", () => ({
  usePluginConfig: () => contextMock.config,
  usePluginSend: () => contextMock.send,
}));

// URL-routed fetch mock: GET → url key, POST → `${url}:POST` key.
const routes: Record<string, unknown> = {};
function mockFetch(map: Record<string, unknown>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const key = init?.method === "POST" ? `${url}:POST` : url;
    const value = map[key] ?? map[url] ?? { ok: true, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  contextMock.config = {};
  contextMock.send = vi.fn();
  mockFetch({
    "/api/pi-matrix-bridge/config": {
      ok: true,
      homeserverUrl: "",
      accessToken: "",
      autoConnect: true,
      encryption: true,
      session: { workspace: "" },
      auth: { trustedUsers: [] },
    },
    "/api/pi-matrix-bridge/status": { ok: true, state: "stopped", pid: null, logs: [] },
  });
});

describe("Settings (client settings-section)", () => {
  it("renders the matrix config form, pairing input, and status panel", () => {
    render(<Settings pluginContext={undefined} />);
    expect(screen.getByTestId("homeserver-url")).toBeInTheDocument();
    expect(screen.getByTestId("access-token")).toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
    expect(screen.getByTestId("trusted-user-input")).toBeInTheDocument();
    expect(screen.getByTestId("session-status")).toBeInTheDocument();
  });

  it("adds a valid trusted user via POST /config (not plugin_config_write)", async () => {
    render(<Settings pluginContext={undefined} />);
    fireEvent.change(screen.getByTestId("trusted-user-input"), {
      target: { value: "@alice:example.org" },
    });
    fireEvent.click(screen.getByTestId("add-user"));

    const post = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as RequestInit)?.method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse((post![1] as RequestInit).body as string) as { trustedUsers: string[] };
    expect(body.trustedUsers).toContain("@alice:example.org");
    expect(contextMock.send).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument();
  });

  it("seeds connection + pairing from GET /config", async () => {
    mockFetch({
      "/api/pi-matrix-bridge/config": {
        ok: true,
        homeserverUrl: "https://file.example.org",
        accessToken: "syt_file_token",
        autoConnect: true,
        encryption: true,
        session: { workspace: "/tmp/ws" },
        auth: { trustedUsers: ["@alice:example.org"] },
      },
      "/api/pi-matrix-bridge/status": { ok: true, state: "stopped", pid: null, logs: [] },
    });
    render(<Settings pluginContext={undefined} />);

    expect(await screen.findByDisplayValue("https://file.example.org")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("syt_file_token")).toBeInTheDocument();
    expect(await screen.findByText("@alice:example.org")).toBeInTheDocument();
  });

  it("rejects an invalid user id with an error and does not POST", () => {
    render(<Settings pluginContext={undefined} />);
    fireEvent.change(screen.getByTestId("trusted-user-input"), { target: { value: "not-a-user" } });
    fireEvent.click(screen.getByTestId("add-user"));

    expect(screen.getByTestId("pair-error")).toBeInTheDocument();
    const posts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[1] as RequestInit)?.method === "POST",
    );
    expect(posts).toHaveLength(0);
  });

  it("shows the session state once the status endpoint responds", async () => {
    mockFetch({
      "/api/pi-matrix-bridge/config": {
        ok: true,
        homeserverUrl: "",
        accessToken: "",
        autoConnect: true,
        encryption: true,
        session: { workspace: "" },
        auth: { trustedUsers: [] },
      },
      "/api/pi-matrix-bridge/status": { ok: true, state: "running", pid: 1234, logs: ["hello", "world"] },
    });
    render(<Settings pluginContext={undefined} />);

    expect(await screen.findByTestId("bridge-state")).toHaveTextContent("running");
    expect(screen.getByText(/PID 1234/)).toBeInTheDocument();
    expect(screen.getByTestId("bridge-logs")).toHaveTextContent("hello");
  });
});