// The older developer pages ask for the password with a plain prompt before an owner action (the decision room has its own signing dialog).
export function askPassword(purpose: string): string | null {
  return typeof window === "undefined" ? null : window.prompt(`Re-enter your password to ${purpose}`);
}
