import { ChildProcess, spawn } from "child_process";

export interface SpawnDaemonOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DaemonHandle {
  proc: ChildProcess;
  waitReady(pattern: RegExp, timeoutMs: number): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

export function spawnDaemon(bin: string, args: string[] = [], opts: SpawnDaemonOptions = {}): DaemonHandle {
  const proc: ChildProcess = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: "pipe",
  });

  function kill(signal: NodeJS.Signals = "SIGKILL"): void {
    try {
      if (proc.exitCode === null && proc.killed !== true) {
        proc.kill(signal);
      }
    } catch {
      // already exited; ignore kill errors
    }
  }

  function waitReady(pattern: RegExp, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let output = "";
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;

      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (proc.stdout !== null && proc.stdout !== undefined) {
          proc.stdout.removeListener("data", onData);
        }
        if (proc.stderr !== null && proc.stderr !== undefined) {
          proc.stderr.removeListener("data", onData);
        }
        proc.removeListener("error", onError);
        proc.removeListener("exit", onExit);
      };

      const settleResolve = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const settleReject = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          kill();
        } catch {
          // ignore
        }
        reject(err);
      };

      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        if (pattern.test(output)) {
          settleResolve();
        }
      };

      const onError = (err: Error): void => {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        settleReject(
          new Error(`daemon exited before ready (code=${String(code)} signal=${String(signal)}) output: ${output.slice(-500)}`)
        );
      };

      timer = setTimeout(() => {
        settleReject(
          new Error(`daemon not ready within ${timeoutMs}ms (pattern ${String(pattern)}) output: ${output.slice(-500)}`)
        );
      }, timeoutMs);

      if (proc.stdout !== null && proc.stdout !== undefined) {
        proc.stdout.on("data", onData);
      }
      if (proc.stderr !== null && proc.stderr !== undefined) {
        proc.stderr.on("data", onData);
      }
      proc.once("error", onError);
      proc.once("exit", onExit);
    });
  }

  return { proc, waitReady, kill };
}
