export interface RequestOptions {
  method: string;
  json?: unknown;
  searchParams?: URLSearchParams;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

export async function fetchJson<T>(path: string, options: RequestOptions): Promise<T> {
  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(path, base);
  if (options.searchParams) {
    url.search = options.searchParams.toString();
  }

  const response = await fetch(url, {
    method: options.method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
    body: options.json != null ? JSON.stringify(options.json) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchVoid(path: string, options: RequestOptions): Promise<void> {
  const base = options.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(path, base);
  if (options.searchParams) {
    url.search = options.searchParams.toString();
  }

  const response = await fetch(url, {
    method: options.method,
    headers: {
      ...options.headers,
    },
    body: options.json != null ? JSON.stringify(options.json) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}
