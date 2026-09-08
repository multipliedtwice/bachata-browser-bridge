import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * REVIEW-11. What the Generic content bundle is built from and to.
 *
 * Named rather than inlined so a test can assert the entry and output without running a build:
 * the entry is the one file Chrome injects into a bound Generic page, and pointing it somewhere
 * else would ship a bundle that is not the content script. The browser targets are the floor
 * the manifest already declares.
 */
export const genericBundleOptions = (outfile = "dist/generic-content.js") => ({
  entryPoints: ["src/content/generic/index.ts"],
  bundle: true,
  outfile,
  platform: "browser",
  format: "iife",
  target: ["chrome114", "firefox115"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

/**
 * REVIEW-11. Build the bundle, creating the directory the output actually goes in.
 *
 * It used to create `dist` whatever the output was, so a build redirected into a scratch
 * directory still wrote the repository — which is exactly what a test redirecting it is trying
 * not to do. The default runner still targets `dist/generic-content.js`, so `npm run build`
 * creates the same directory it always did.
 */
export const buildGenericBundle = async (outfile) => {
  const options = genericBundleOptions(outfile);
  await mkdir(path.dirname(path.resolve(options.outfile)), { recursive: true });
  return build(options);
};

// Running this file builds; importing it does not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await buildGenericBundle();
}
