/**
 * Session context for the React UI.
 *
 * The UI uses the role and scopes ONLY to decide which controls to render.
 * Every action is re-authorised by the endpoint, and RLS sits behind that, so a
 * user who edits this state in devtools gets refusals, not data.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Role = "admin" | "editor" | "approver" | "viewer";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  /** Tenant ids, or ["*"]. The server is authoritative; the UI never filters tenancy itself. */
  tenantScopes: string[];
}

export type SessionState =
  | { status: "loading" }
  | { status: "ready"; user: SessionUser }
  /**
   * Signed in to Helix, but no account here yet: the everyday state of someone
   * just invited. The server has recorded the sign-in on the admin's waiting list.
   */
  | { status: "noAccess"; inviteError?: string }
  /** The server could not be reached. Never fall back to a fake session: say so. */
  | { status: "error"; message: string };

const Ctx = createContext<SessionState>({ status: "loading" });

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const set = (s: SessionState) => !cancelled && setState(s);
    (async () => {
      try {
        const res = await fetch("/api/session");
        if (res.ok) return set({ status: "ready", user: (await res.json()).user });
        // A REFUSAL is not an outage: 401/403 means "no account", not "server down".
        if (res.status !== 401 && res.status !== 403) return set({ status: "error", message: `session: HTTP ${res.status}` });

        // Opened an invite link? Redeem it, then reload into the app.
        const token = new URLSearchParams(window.location.search).get("invite");
        if (!token) return set({ status: "noAccess" });
        const redeem = await post("/api/invites/redeem", { token });
        if (redeem.ok) return window.location.replace("/");
        const reason = ((await redeem.json().catch(() => ({}))) as { message?: string }).message;
        set({ status: "noAccess", inviteError: reason ?? "this invite link could not be used" });
      } catch (e) {
        set({ status: "error", message: e instanceof Error ? e.message : "network error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  return useContext(Ctx);
}

/** Render children only for a signed-in user with an account; otherwise say why not. */
export function AccessGate({ children }: { children: ReactNode }) {
  const s = useSession();
  if (s.status === "loading") return <p>Loading…</p>;
  if (s.status === "error") return <p role="alert">Could not reach the server: {s.message}</p>;
  if (s.status === "noAccess") {
    return (
      <section>
        <h1>You don't have access yet</h1>
        {s.inviteError ? <p role="alert">{s.inviteError}</p> : null}
        <p>Your sign-in has been recorded. Ask an admin to connect it to your account, or open the invite link they sent you.</p>
      </section>
    );
  }
  return <>{children}</>;
}

// ---- affordances only: the server re-checks every one of these ----

export function inScope(user: SessionUser | undefined, tenantId: string): boolean {
  return !!user && (user.tenantScopes.includes("*") || user.tenantScopes.includes(tenantId));
}

/** Approve / decline. */
export function canDecide(user: SessionUser | undefined, tenantId: string): boolean {
  return (user?.role === "approver" || user?.role === "admin") && inScope(user, tenantId);
}

/** Change tenant data or configuration. */
export function canEdit(user: SessionUser | undefined, tenantId: string): boolean {
  return (user?.role === "editor" || user?.role === "admin") && inScope(user, tenantId);
}

/** The People page: admin AND every tenant. */
export function canManagePeople(user: SessionUser | undefined): boolean {
  return user?.role === "admin" && user.tenantScopes.includes("*");
}
