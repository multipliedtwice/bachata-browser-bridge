import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPackages = [
  /^@sentry\//u,
  /^sentry(?:-|$)/u,
  /^@segment\//u,
  /^analytics-node$/u,
  /^posthog(?:-|$)/u,
  /^mixpanel(?:-|$)/u,
  /^@amplitude\//u,
  /^amplitude(?:-|$)/u,
  /^@datadog\//u,
  /^dd-trace$/u,
  /^applicationinsights$/u,
  /^newrelic$/u,
  /^@opentelemetry\//u,
  /^plausible(?:-|$)/u,
  /^umami(?:-|$)/u,
  /^matomo(?:-|$)/u,
  /^snowplow(?:-|$)/u,
];
const forbiddenHosts = [
  "sentry.io",
  "segment.io",
  "posthog.com",
  "mixpanel.com",
  "amplitude.com",
  "datadoghq.com",
  "newrelic.com",
  "nr-data.net",
  "services.visualstudio.com",
  "plausible.io",
  "umami.is",
  "matomo.cloud",
  "snowplow.io",
];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const matchesPackage = (name) => forbiddenPackages.some((pattern) => pattern.test(name));

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(target);
    }
    return sourceExtensions.has(path.extname(entry.name)) ? [target] : [];
  }));
  return nested.flat();
};

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const dependencyNames = Object.keys({
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
  ...packageJson.optionalDependencies,
  ...packageJson.peerDependencies,
});
const violations = dependencyNames
  .filter(matchesPackage)
  .map((name) => `forbidden dependency: ${name}`);

const scannedFiles = (
  await Promise.all(["src", "scripts"].map((directory) => sourceFiles(path.join(root, directory))))
).flat().filter((file) => path.resolve(file) !== fileURLToPath(import.meta.url));

for (const file of scannedFiles) {
  const source = await readFile(file, "utf8");
  const imports = Array.from(source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/gu), (match) => match[1]);
  imports.filter(matchesPackage).forEach((name) => {
    violations.push(`forbidden import in ${path.relative(root, file)}: ${name}`);
  });
  const urls = Array.from(source.matchAll(/https?:\/\/[^\s"'`)]+/gu), (match) => match[0]);
  urls.forEach((value) => {
    let hostname;
    try {
      hostname = new URL(value).hostname.toLowerCase();
    } catch {
      return;
    }
    if (forbiddenHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      violations.push(`forbidden reporting endpoint in ${path.relative(root, file)}: ${hostname}`);
    }
  });
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("No telemetry dependencies, imports, or reporting endpoints detected.\n");
}
