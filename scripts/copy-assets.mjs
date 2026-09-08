import { cp, mkdir } from "node:fs/promises";
import { generateThirdPartyNotices } from "./third-party-notices.mjs";

await mkdir("dist/popup", { recursive: true });
await cp("manifest.json", "dist/manifest.json");
await cp("src/popup/index.html", "dist/popup/index.html");
await cp("LICENSE", "dist/LICENSE");
await generateThirdPartyNotices("dist/THIRD_PARTY_NOTICES.txt");
