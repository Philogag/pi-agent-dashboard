// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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

function mockStatus(status: Record<string, unknown>) {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => status })) as unknown as typeof fetch;
}

beforeEach(() => {
  contextMock.config = {};
  contextMock.send = vi.fn();
  mockStatus({ ok: true, state: "stopped", pid: null, logs: [] });
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

  it("adds a valid trusted user and persists it via plugin_config_write", async () => {
    render(<Settings pluginContext={undefined} />);
    fireEvent.change(screen.getByTestId("trusted-user-input"), {
      target: { value: "@alice:example.org" },
    });
    fireEvent.click(screen.getByTestId("add-user"));

    expect(contextMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "plugin_config_write",
        id: "pi-matrix-bridge",
      }),
    );
    const sent = contextMock.send.mock.calls[0][0] as { config: { auth: { trustedUsers: string[] } } };
    expect(sent.config.auth.trustedUsers).toContain("@alice:example.org");
    expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument();
  });

  it("rejects an invalid user id with an error and does not persist", () => {
    render(<Settings pluginContext={undefined} />);
    fireEvent.change(screen.getByTestId("trusted-user-input"), { target: { value: "not-a-user" } });
    fireEvent.click(screen.getByTestId("add-user"));

    expect(screen.getByTestId("pair-error")).toBeInTheDocument();
    expect(contextMock.send).not.toHaveBeenCalled();
    expect(contextMock.config.auth).toBeUndefined();
  });

  it("shows the session state once the status endpoint responds", async () => {
    mockStatus({ ok: true, state: "running", pid: 1234, logs: ["hello", "world"] });
    render(<Settings pluginContext={undefined} />);

    expect(await screen.findByTestId("bridge-state")).toHaveTextContent("running");
    expect(screen.getByText(/PID 1234/)).toBeInTheDocument();
    expect(screen.getByTestId("bridge-logs")).toHaveTextContent("hello");
  });
});
