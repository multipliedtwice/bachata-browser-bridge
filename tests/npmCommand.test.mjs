import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { npmInvocation } from "../scripts/lib/npmCommand.mjs";

test("Windows npm runs its JavaScript entry without interpreting arguments as shell syntax", () => {
  const args = ["run", "check", "--", "a & b", "$(literal)"];
  const result = npmInvocation(args, {
    platform: "win32",
    executable: "/node/node.exe",
    npmPath: "/npm with spaces/npm-cli.js",
    exists: (candidate) => candidate === "/npm with spaces/npm-cli.js",
  });
  assert.deepEqual(result, {
    command: "/node/node.exe",
    args: ["/npm with spaces/npm-cli.js", ...args],
  });
});

test("Windows npm can resolve the Node installation's bundled CLI", () => {
  const installedCli = path.join("/node", "node_modules", "npm", "bin", "npm-cli.js");
  assert.deepEqual(npmInvocation(["ls"], {
    platform: "win32",
    executable: "/node/node.exe",
    npmPath: undefined,
    exists: (candidate) => candidate === installedCli,
  }), {
    command: "/node/node.exe",
    args: [installedCli, "ls"],
  });
});

test("a missing npm entry point fails before launching a process", () => {
  assert.throws(() => npmInvocation([], { platform: "win32", exists: () => false }), /Cannot locate npm/u);
});

test("POSIX npm keeps direct argument passing", () => {
  assert.deepEqual(npmInvocation(["ls"], { platform: "linux" }), { command: "npm", args: ["ls"] });
});
