import { NotFoundError, Sandbox, type SandboxBetaCreateOpts, type SandboxConnectOpts } from "@e2b/code-interpreter";
import { SandboxDestroyedError } from "../client.ts";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_AGENTS, SANDBOX_AGENT_INSTALL_SCRIPT } from "./shared.ts";

/**
 * urun provider — agent sandboxes on urun's E2B-compatible wire.
 *
 * urun (https://urun.sh) hosts agent sandboxes as Firecracker microVMs that
 * are 100% E2B wire-compatible: point the unmodified e2b SDKs at
 * E2B_DOMAIN=sandbox.urun.sh and they work as-is. This provider is the same
 * shape as the e2b provider but names itself "urun", so a provider change is
 * detectable in stored sandbox IDs, and it can pick urun-specific defaults
 * (pause-first lifecycle) without touching the e2b entry.
 */

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 3_600_000;
const DEFAULT_TEMPLATE = "base";
const SANDBOX_AGENT_PATH_EXPORT = 'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"';

type UrunCreateOverrides = Omit<Partial<SandboxBetaCreateOpts>, "timeoutMs" | "autoPause">;
type UrunConnectOverrides = Omit<Partial<SandboxConnectOpts>, "timeoutMs">;
type UrunTemplateOverride = string | (() => string | Promise<string>);

export interface UrunProviderOptions {
  create?: UrunCreateOverrides | (() => UrunCreateOverrides | Promise<UrunCreateOverrides>);
  connect?: UrunConnectOverrides | ((sandboxId: string) => UrunConnectOverrides | Promise<UrunConnectOverrides>);
  template?: UrunTemplateOverride;
  agentPort?: number;
  timeoutMs?: number;
  autoPause?: boolean;
}

async function resolveOptions(value: UrunProviderOptions["create"] | UrunProviderOptions["connect"], sandboxId?: string): Promise<Record<string, unknown>> {
  if (!value) return {};
  if (typeof value === "function") {
    if (sandboxId) {
      return await (value as (id: string) => Record<string, unknown> | Promise<Record<string, unknown>>)(sandboxId);
    }
    return await (value as () => Record<string, unknown> | Promise<Record<string, unknown>>)();
  }
  return value;
}

async function resolveTemplate(value: UrunTemplateOverride | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  return typeof value === "function" ? await value() : value;
}

function buildShellCommand(command: string, strict = false): string {
  const strictPrefix = strict ? "set -euo pipefail; " : "";
  return `bash -lc '${strictPrefix}${SANDBOX_AGENT_PATH_EXPORT}; ${command}'`;
}

export function urun(options: UrunProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // urun's lease machinery parks on expiry; autoPause keeps the sandbox
  // resumable instead of freeing it, which is the durable-actors default.
  const autoPause = options.autoPause ?? true;

  return {
    name: "urun",
    defaultCwd: "/home/user",
    async create(): Promise<string> {
      const createOpts = await resolveOptions(options.create);
      const rawTemplate = typeof createOpts.template === "string" ? createOpts.template : undefined;
      const restCreateOpts = { ...createOpts };
      delete restCreateOpts.template;
      const template = (await resolveTemplate(options.template)) ?? rawTemplate ?? DEFAULT_TEMPLATE;
      const sandbox = await Sandbox.betaCreate(template, {
        allowInternetAccess: true,
        ...restCreateOpts,
        timeoutMs,
        autoPause,
      } as SandboxBetaCreateOpts);

      await sandbox.commands.run(buildShellCommand(`curl -fsSL ${SANDBOX_AGENT_INSTALL_SCRIPT} | sh`, true)).then((r) => {
        if (r.exitCode !== 0) throw new Error(`urun install failed:\n${r.stderr}`);
      });
      for (const agent of DEFAULT_AGENTS) {
        await sandbox.commands.run(buildShellCommand(`sandbox-agent install-agent ${agent}`)).then((r) => {
          if (r.exitCode !== 0) throw new Error(`urun agent install failed: ${agent}\n${r.stderr}`);
        });
      }
      await sandbox.commands.run(buildShellCommand(`sandbox-agent server --no-token --host 0.0.0.0 --port ${agentPort}`), { background: true, timeoutMs: 0 });

      return sandbox.sandboxId;
    },
    async destroy(sandboxId: string): Promise<void> {
      await this.pause?.(sandboxId);
    },
    async reconnect(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      try {
        await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new SandboxDestroyedError(sandboxId, "urun", { cause: error });
        }
        throw error;
      }
    },
    async pause(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      await sandbox.betaPause();
    },
    async kill(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      await sandbox.kill();
    },
    async getUrl(sandboxId: string): Promise<string> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      return `https://${sandbox.getHost(agentPort)}`;
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      await sandbox.commands.run(buildShellCommand(`sandbox-agent server --no-token --host 0.0.0.0 --port ${agentPort}`), { background: true, timeoutMs: 0 });
    },
  };
}
