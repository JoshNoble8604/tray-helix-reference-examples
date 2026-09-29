/**
 * Request plumbing shared by every module: typed HTTP errors and settings.
 */
import { getContext } from "@trayai/helix-sdk";

/** An HTTP failure. The SDK reads `statusCode` off a thrown value. */
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Throw an HTTP error from code that has no `ctx` in hand (shared modules).
 * `getContext()` throws outside an invocation; that must never replace the
 * error you meant to raise, so the fallback is a plain HttpError.
 */
export function httpError(status: number, message: string): never {
  const ctx = currentContext() as { error?: (s: number, m: string) => void } | null;
  if (typeof ctx?.error === "function") ctx.error(status, message);
  throw new HttpError(status, message);
}

function currentContext(): unknown {
  try {
    return getContext();
  } catch {
    return null;
  }
}

/**
 * A project setting. On Helix, settings arrive on `ctx.config`; `process.env`
 * covers local runs and tests. Blank counts as unset, so a gate keyed on a
 * setting fails closed when someone configures it as "".
 */
export function setting(name: string): string | undefined {
  const fromCtx = (currentContext() as { config?: Record<string, unknown> } | null)?.config?.[name];
  const value = fromCtx ?? process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
