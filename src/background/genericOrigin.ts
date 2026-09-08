export const validHttpOrigin = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value && !parsed.hostname.includes("*")
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
};

const builtInProviderHostnames = new Set(["chatgpt.com", "www.chatgpt.com", "claude.ai", "www.claude.ai"]);

export const isBuiltInProviderLocation = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && builtInProviderHostnames.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};
