declare const chrome: any;
declare const browser: any;
declare module "turndown-plugin-gfm" {
  import type { Plugin } from "turndown";
  export const gfm: Plugin;
}
