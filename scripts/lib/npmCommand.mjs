import { existsSync } from "node:fs";
import path from "node:path";

export const npmInvocation = (args, {
  platform = process.platform,
  executable = process.execPath,
  npmPath = process.env.npm_execpath,
  exists = existsSync,
} = {}) => {
  if (platform !== "win32") return { command: "npm", args };
  const candidates = [npmPath, path.join(path.dirname(executable), "node_modules", "npm", "bin", "npm-cli.js")];
  const cli = candidates.find((candidate) => candidate && exists(candidate));
  if (!cli) throw new Error("Cannot locate npm's JavaScript entry point. Run this command through npm run.");
  return { command: executable, args: [cli, ...args] };
};
