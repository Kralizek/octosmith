import { assert, assertEquals, assertThrows } from "@std/assert";
import { E2E_OWNER, runPrefix, safeRepository } from "./e2e/runtime.ts";

Deno.test("E2E refuses non-dedicated owners and malformed run IDs", () => {
  assertThrows(() => runPrefix("Kralizek", "123-1"));
  assertThrows(() => runPrefix(E2E_OWNER, "local"));
  assertEquals(runPrefix(E2E_OWNER, "123-1"), "octosmith-e2e-123-1-");
});

Deno.test("E2E cleanup guard protects fixture and unrelated repositories", () => {
  const prefix = runPrefix(E2E_OWNER, "123-1");
  const repo = (name: string, owner = E2E_OWNER) => ({
    name,
    id: 42,
    private: true,
    default_branch: "main",
    full_name: owner + "/" + name,
  });
  assert(safeRepository(prefix, repo(prefix + "declarative")));
  assert(!safeRepository(prefix, repo("fixtures")));
  assert(!safeRepository(prefix, repo("production")));
  assert(!safeRepository(prefix, repo(prefix + "test", "another-org")));
});
