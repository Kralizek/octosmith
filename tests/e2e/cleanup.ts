import { E2ERuntime } from "./runtime.ts";

const runtime = E2ERuntime.fromEnvironment();
await runtime.cleanup();
