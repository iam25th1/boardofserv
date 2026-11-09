import "server-only";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import type { ToolName } from "./definition";
import { gate, ToolError } from "./toolbox";

// The sandbox a code step runs in: QuickJS compiled to WebAssembly, one
// fresh runtime per step. It has no network, no files, no modules, no
// timers and no host objects: a step's code sees its input (as JSON) and a
// `tools` object whose functions call one host function, the bridge, with
// a tool name and JSON arguments, and get JSON back. The bridge lets
// through only the tools the step lists, and the toolbox checks the
// arguments. Nothing but strings crosses, so no prototype trick inside can
// reach the host. A time limit (interrupting even an endless loop) and a
// memory limit stop code that runs away.

export const DEFAULT_TIME_MS = 5_000;
export const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 1_000_000;

// One WebAssembly instance, made again after any fault on the host side
// (a wasm trap leaves it in no state to trust).
let instance: Promise<QuickJSWASMModule> | null = null;
const quickjs = () => (instance ??= newQuickJSWASMModuleFromVariant(variant));

// QuickJS's own stack limit, small enough that deep recursion stops inside
// it, as a plain error, long before the host's stack.
const STACK_BYTES = 96 * 1024;

export type SandboxResult = { ok: true; output: unknown; ms: number } | { ok: false; error: string; ms: number };

export interface SandboxOptions {
  // The step's tools: the only names the bridge lets through.
  allowed: readonly ToolName[];
  // Answers a tool call (the mocks on the test bench).
  call: (tool: ToolName, args: unknown) => Promise<unknown>;
  timeMs?: number;
  memoryBytes?: number;
}

// What a QuickJS error says, in plain words.
function explain(dumped: unknown, timeMs: number): string {
  const e = (dumped && typeof dumped === "object" ? dumped : { message: String(dumped) }) as { name?: string; message?: string };
  if (e.message === "interrupted") return `It ran out of time (${timeMs / 1000} seconds).`;
  if (e.message === "out of memory") return "It used too much memory.";
  if (/stack overflow/i.test(e.message ?? "")) return "It went too deep (stack overflow).";
  return `${e.name ?? "Error"}: ${e.message ?? "it failed"}`.slice(0, 500);
}

// The prelude: builds the frozen `tools` object around the bridge, takes the
// bridge off the global object, and keeps its own JSON functions, so code
// that replaces JSON's can't change what crosses.
function prelude(allowed: readonly ToolName[]): string {
  return `(() => {
  const bridge = globalThis.__bridge;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  delete globalThis.__bridge;
  const tools = {};
  for (const name of ${JSON.stringify(allowed)}) {
    const [group, fn] = name.split(".");
    tools[group] = tools[group] || {};
    tools[group][fn] = async (args) => parse(await bridge(name, stringify(args === undefined ? null : args)));
  }
  for (const group of Object.keys(tools)) Object.freeze(tools[group]);
  Object.defineProperty(globalThis, "__tools", { value: Object.freeze(tools) });
  Object.defineProperty(globalThis, "__json", { value: Object.freeze({ parse, stringify }) });
})();`;
}

export async function runInSandbox(source: string, input: unknown, opts: SandboxOptions): Promise<SandboxResult> {
  const started = Date.now();
  const timeMs = opts.timeMs ?? DEFAULT_TIME_MS;
  const ms = () => Date.now() - started;
  const inputJson = JSON.stringify(input ?? null);
  if (inputJson.length > MAX_JSON_BYTES) return { ok: false, error: "Its input is too large.", ms: ms() };

  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryBytes ?? DEFAULT_MEMORY_BYTES);
  runtime.setMaxStackSize(STACK_BYTES);
  const deadline = Date.now() + timeMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm: QuickJSContext = runtime.newContext();
  let alive = true;
  // A fault on the host side: the instance is dropped, not cleaned up.
  let faulted = false;
  const pending = new Set<QuickJSDeferredPromise>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (d: QuickJSDeferredPromise, how: { value: string } | { error: string }) => {
    if (!alive || !pending.has(d)) return;
    pending.delete(d);
    if ("value" in how) {
      const v = vm.newString(how.value);
      d.resolve(v);
      v.dispose();
    } else {
      const e = vm.newError(how.error);
      d.reject(e);
      e.dispose();
    }
    if (alive) runtime.executePendingJobs();
  };

  try {
    const bridge = vm.newFunction("__bridge", (nameH: QuickJSHandle, argsH: QuickJSHandle) => {
      const d = vm.newPromise();
      pending.add(d);
      try {
        // Only strings cross: anything else is refused before it is read.
        if (vm.typeof(nameH) !== "string" || vm.typeof(argsH) !== "string") throw new ToolError("bridge", "Tools take a name and JSON arguments.");
        const name = gate(opts.allowed, vm.getString(nameH));
        const raw = vm.getString(argsH);
        if (raw.length > MAX_JSON_BYTES) throw new ToolError(name, "The arguments are too large.");
        const args = JSON.parse(raw) as unknown;
        opts.call(name, args).then(
          (result) => {
            const out = JSON.stringify(result ?? null);
            settle(d, out.length > MAX_JSON_BYTES ? { error: `${name} answered with too much.` } : { value: out });
          },
          (err: unknown) => settle(d, { error: err instanceof Error ? err.message : `${name} failed.` }),
        );
      } catch (err) {
        // Settled on the next tick, so the promise handle is returned first.
        const message = err instanceof Error ? err.message : "That tool call failed.";
        queueMicrotask(() => settle(d, { error: message }));
      }
      return d.handle;
    });
    vm.setProp(vm.global, "__bridge", bridge);
    bridge.dispose();
    const inputH = vm.newString(inputJson);
    vm.setProp(vm.global, "__input", inputH);
    inputH.dispose();

    const ready = vm.evalCode(prelude(opts.allowed));
    if (ready.error) {
      const why = explain(vm.dump(ready.error), timeMs);
      ready.error.dispose();
      return { ok: false, error: why, ms: ms() };
    }
    ready.value.dispose();

    const wrapped = `${source}
;(async () => {
  if (typeof run !== "function") throw new Error("There is no run function.");
  const out = await run(__json.parse(__input), __tools);
  return __json.stringify(out === undefined ? null : out);
})()`;
    const started2 = vm.evalCode(wrapped, "step.js");
    if (started2.error) {
      const why = explain(vm.dump(started2.error), timeMs);
      started2.error.dispose();
      return { ok: false, error: why, ms: ms() };
    }
    const native = vm.resolvePromise(started2.value);
    started2.value.dispose();
    runtime.executePendingJobs();

    const outOfTime = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    const settled = await Promise.race([native, outOfTime]);
    if (settled === "timeout") return { ok: false, error: `It ran out of time (${timeMs / 1000} seconds).`, ms: ms() };
    if (settled.error) {
      const why = explain(vm.dump(settled.error), timeMs);
      settled.error.dispose();
      return { ok: false, error: why, ms: ms() };
    }
    const text = vm.typeof(settled.value) === "string" ? vm.getString(settled.value) : null;
    settled.value.dispose();
    if (text === null) return { ok: false, error: "It returned something that isn't JSON.", ms: ms() };
    if (text.length > MAX_JSON_BYTES) return { ok: false, error: "It returned too much.", ms: ms() };
    return { ok: true, output: JSON.parse(text) as unknown, ms: ms() };
  } catch (err) {
    faulted = true;
    instance = null;
    const deep = err instanceof RangeError;
    return { ok: false, error: deep ? "It went too deep (stack overflow)." : "The sandbox stopped it.", ms: ms() };
  } finally {
    clearTimeout(timer);
    alive = false;
    if (faulted) {
      // Dropped, not disposed: freeing a runtime after a trap can trap again.
      pending.clear();
    } else {
      // Anything still waiting on a tool is turned down before the runtime goes.
      for (const d of [...pending]) {
        pending.delete(d);
        try {
          const e = vm.newError("The step ended.");
          d.reject(e);
          e.dispose();
        } catch {
          d.dispose();
        }
      }
      try {
        vm.dispose();
        runtime.dispose();
      } catch (err) {
        instance = null;
        console.error(`sandbox: not cleaned up: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
  }
}
