import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the urun sandbox provider — mock @e2b/code-interpreter and
 * assert the provider drives the E2B wire exactly like the e2b provider,
 * under the "urun" name and with urun's defaults (base template,
 * autoPause=true).
 */

type Call = { method: string; args: unknown[] };

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface MockSandbox {
  sandboxId: string;
  commands: { run: (...args: unknown[]) => Promise<ExecResult> };
  betaPause(): Promise<void>;
  kill(): Promise<void>;
  getHost(port: number): string;
}

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    createdIds: [] as string[],
    connectMissing: new Set<string>(),
    paused: new Set<string>(),
    killed: new Set<string>(),
    createOptions: null as Record<string, unknown> | null,
    createTemplate: undefined as unknown,
  };

  const ok: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

  class NotFoundError extends Error {}

  const makeSandbox = (id: string): MockSandbox => ({
    sandboxId: id,
    commands: {
      run: async (command: string, options?: Record<string, unknown>) => {
        state.calls.push({ method: "commands.run", args: [command, options] });
        return ok;
      },
    },
    betaPause: async () => {
      state.paused.add(id);
    },
    kill: async () => {
      state.killed.add(id);
    },
    getHost: (port: number) => `${port}-${id}.sandbox.urun.sh`,
  });

  const Sandbox = Object.assign(class {}, {
    betaCreate: vi.fn(async (template?: unknown, opts?: unknown) => {
      state.calls.push({ method: "betaCreate", args: [template, opts] });
      state.createTemplate = template;
      state.createOptions = (opts ?? {}) as Record<string, unknown>;
      const id = `sbx_${state.createdIds.length + 1}`;
      state.createdIds.push(id);
      return makeSandbox(id);
    }),
    connect: vi.fn(async (id: string, opts?: unknown) => {
      state.calls.push({ method: "connect", args: [id, opts] });
      if (state.connectMissing.has(id)) throw new NotFoundError(id);
      return makeSandbox(id);
    }),
  });

  return { NotFoundError, Sandbox, state };
});

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: h.Sandbox,
  NotFoundError: h.NotFoundError,
}));

import { urun } from "../src/providers/urun.ts";
import type { SandboxProvider } from "../src/providers/types.ts";

const calls = (method: string) => h.state.calls.filter((c) => c.method === method);

beforeEach(() => {
  h.state.calls = [];
  h.state.createdIds = [];
  h.state.connectMissing.clear();
  h.state.paused.clear();
  h.state.killed.clear();
  h.state.createOptions = null;
  h.state.createTemplate = undefined;
});

describe("urun provider", () => {
  it("is named 'urun' with /home/user cwd", () => {
    const provider: SandboxProvider = urun();
    expect(provider.name).toBe("urun");
    expect(provider.defaultCwd).toBe("/home/user");
  });

  it("creates from the 'base' template with autoPause on, installs the agent, and starts the server", async () => {
    const provider = urun();
    const id = await provider.create!();
    expect(id).toBe("sbx_1");
    expect(h.state.createTemplate).toBe("base");
    expect(h.state.createOptions).toMatchObject({ allowInternetAccess: true, autoPause: true });

    const runCommands = calls("commands.run").map((c) => (c.args[0] as string).trim());
    expect(runCommands.some((c) => c.includes("curl -fsSL") && c.includes("install.sh") === false)).toBe(false);
    expect(runCommands.some((c) => c.includes("sandbox-agent install-agent claude"))).toBe(true);
    expect(runCommands.some((c) => c.includes("sandbox-agent install-agent codex"))).toBe(true);
    const serverStart = calls("commands.run").find((c) => (c.args[0] as string).includes("sandbox-agent server"));
    expect(serverStart).toBeDefined();
    expect(serverStart?.args[1]).toMatchObject({ background: true, timeoutMs: 0 });
    expect((serverStart?.args[0] as string).includes("--port 3000")).toBe(true);
  });

  it("honors a template override", async () => {
    const provider = urun({ template: "code-interpreter-v1" });
    await provider.create!();
    expect(h.state.createTemplate).toBe("code-interpreter-v1");
  });

  it("pause (used by destroy) beta-pauses the sandbox", async () => {
    const provider = urun();
    const id = await provider.create!();
    await provider.pause!(id);
    expect(h.state.paused.has(id)).toBe(true);
    expect(h.state.killed.has(id)).toBe(false);
  });

  it("kill connects and kills", async () => {
    const provider = urun();
    const id = await provider.create!();
    await provider.kill!(id);
    expect(h.state.killed.has(id)).toBe(true);
  });

  it("getUrl returns the {port}-{id} preview host", async () => {
    const provider = urun();
    const id = await provider.create!();
    const url = await provider.getUrl!(id);
    expect(url).toBe("https://3000-sbx_1.sandbox.urun.sh");
  });

  it("reconnect surfaces NotFoundError as SandboxDestroyedError", async () => {
    const provider = urun();
    h.state.connectMissing.add("sbx_gone");
    await expect(provider.reconnect!("sbx_gone")).rejects.toThrow(/destroyed|sbx_gone/i);
  });

  it("ensureServer starts the server again without reinstalling", async () => {
    const provider = urun();
    const id = await provider.create!();
    h.state.calls = [];
    await provider.ensureServer!(id);
    const runCommands = calls("commands.run").map((c) => (c.args[0] as string).trim());
    expect(runCommands.some((c) => c.includes("curl"))).toBe(false);
    expect(runCommands.some((c) => c.includes("sandbox-agent server"))).toBe(true);
  });
});
