import { probeDroidBinary } from "@fusion-plugin-examples/droid-runtime/probe";

export type DroidCliBinaryStatus = Awaited<ReturnType<typeof probeDroidBinary>>;

export async function probeDroidCli(options: { timeoutMs?: number } = {}): Promise<DroidCliBinaryStatus> {
  return probeDroidBinary({ timeoutMs: options.timeoutMs });
}
