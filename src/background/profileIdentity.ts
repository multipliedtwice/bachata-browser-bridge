import type { GenericBindingProfile } from "../content/generic/types.js";

export const profileIdentity = async (profile: GenericBindingProfile): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(profile));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
