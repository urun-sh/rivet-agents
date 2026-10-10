import {
	CommandExitError,
	Sandbox as E2BSandbox,
	SandboxNotFoundError,
	FileType,
	TimeoutError,
	type SandboxOpts,
} from "e2b";
import type { Sandbox, SandboxProvider } from "./index.js";

/**
 * urun provider — agent sandboxes on urun's E2B-compatible wire.
 *
 * Same shape as the e2b provider, named "urun" so a provider change is
 * detected on actor wake, with urun's defaults: the `base` template and
 * lifecycle onTimeout "pause" with autoResume (urun's lease expiry parks the
 * sandbox; the next tool use wakes it).
 */
export interface UrunProviderOptions {
	/** Template name or id. Defaults to `base`. */
	template?: string;
	/** Options for `Sandbox.create`. The API key defaults to `E2B_API_KEY`. */
	create?: SandboxOpts;
	/** Working directory inside the sandbox. Defaults to `/home/user`. */
	cwd?: string;
}

export function urunProvider(
	options: UrunProviderOptions = {},
): SandboxProvider {
	const cwd = options.cwd ?? "/home/user";
	return {
		name: "urun",
		cwd,
		create: async () =>
			(
				await E2BSandbox.create(options.template ?? "base", {
					// urun parks a sandbox when its timeout ends, even while the
					// actor is using it, and the next tool use resumes it.
					lifecycle: { onTimeout: "pause", autoResume: true },
					...options.create,
				})
			).sandboxId,
		connect: async (_c, id) => {
			try {
				return urunSandbox(await E2BSandbox.connect(id, options.create), cwd);
			} catch (error) {
				if (error instanceof SandboxNotFoundError) return undefined;
				throw error;
			}
		},
		suspend: async (_c, id) => {
			await E2BSandbox.pause(id, options.create);
		},
		destroy: async (_c, id) => {
			await E2BSandbox.kill(id, options.create);
		},
	};
}

function urunSandbox(sandbox: E2BSandbox, cwd: string): Sandbox {
	return {
		cwd,
		exec: async (command, options) => {
			const handle = await sandbox.commands.run(command, {
				background: true,
				cwd: options.cwd,
				envs: options.env,
				// The SDK applies a 60 second deadline when this is undefined. 0 disables it.
				timeoutMs: options.timeoutMs ?? 0,
				onStdout: (data) => options.onData?.(Buffer.from(data)),
				onStderr: (data) => options.onData?.(Buffer.from(data)),
			});
			const kill = () => void handle.kill();
			options.signal?.addEventListener("abort", kill, { once: true });
			const result = await handle
				.wait()
				.catch((error: unknown) => {
					// E2B throws when a command exits non-zero. That is a normal result for a tool.
					if (error instanceof CommandExitError) return error;
					// The deadline ends the output stream but leaves the process running.
					if (error instanceof TimeoutError && options.timeoutMs !== undefined)
						return "timeout";
					throw error;
				})
				.finally(() => options.signal?.removeEventListener("abort", kill));
			if (options.signal?.aborted) throw new Error("aborted");
			if (result === "timeout") {
				await handle.kill();
				return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
			}
			return {
				exitCode: result.exitCode,
				timedOut: false,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		},
		readFile: (path) => sandbox.files.read(path, { format: "bytes" }),
		writeFile: async (path, content) => {
			await sandbox.files.write(path, content);
		},
		mkdir: async (path) => {
			await sandbox.files.makeDir(path);
		},
		stat: async (path) => ({
			isDirectory: (await sandbox.files.getInfo(path)).type === FileType.DIR,
		}),
		readdir: async (path) =>
			(await sandbox.files.list(path)).map((entry) => entry.name),
		exists: (path) => sandbox.files.exists(path),
	};
}
