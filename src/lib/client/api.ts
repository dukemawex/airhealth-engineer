"use client";

/**
 * Browser helpers. When the deployment sets API_AUTH_TOKEN, the user pastes the
 * token once (Access dialog) and it is kept in localStorage on this device only.
 */
const TOKEN_KEY = "airhealth.apiToken";
const CONVERSATION_KEY = "airhealth.conversationId";

export const tokenStore = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export const conversationStore = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(CONVERSATION_KEY)),
  set: (id: string) => window.localStorage.setItem(CONVERSATION_KEY, id),
  clear: () => window.localStorage.removeItem(CONVERSATION_KEY),
};

export function authHeaders(): Record<string, string> {
  const t = tokenStore.get();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | undefined)?.error;
    throw new ApiError(err?.message ?? `Request failed (${res.status})`, res.status, err?.code);
  }
  return data as T;
}

/** Fetch that resolves even for 503 (health reports degraded with 503 but a JSON body). */
export async function fetchJsonLoose<T>(path: string): Promise<{ status: number; data?: T }> {
  try {
    const res = await fetch(path, { headers: authHeaders(), cache: "no-store" });
    const data = (await res.json().catch(() => undefined)) as T | undefined;
    return { status: res.status, data };
  } catch {
    return { status: 0 };
  }
}
