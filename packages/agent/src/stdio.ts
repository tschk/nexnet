import { AgentCore } from "./core.js";
import type { Outbound, Platform } from "./types.js";

export async function serveStdio(platform: Platform): Promise<void> {
  const write = (output: Outbound) => {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  };
  const core = new AgentCore(platform, write);
  try {
    await core.init();
  } catch (error) {
    write({ event: "error", code: "internal", message: error instanceof Error ? error.message : "Wallet unavailable" });
  }
  const decoder = new TextDecoder();
  let pending = "";
  const inflight = new Set<Promise<void>>();
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) {
        const task = core.handleLine(line).finally(() => inflight.delete(task));
        inflight.add(task);
      }
      newline = pending.indexOf("\n");
    }
    if (pending.length > 65_536) pending = "";
  }
  await Promise.allSettled(inflight);
  core.close();
}
