export interface RequestOptions {
  method: string;
  body?: BodyInit | null;
  contentType?: "application/json" | "application/octet-stream" | "multipart/form-data";
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
    headers: buildHeaders(options, true),
    body: buildBody(options),
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
    headers: buildHeaders(options, false),
    body: buildBody(options),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
}

function buildHeaders(
  options: RequestOptions,
  expectsJsonResponse: boolean,
): Record<string, string> {
  const headers = { ...options.headers };

  if (options.json != null) {
    headers["Content-Type"] = "application/json";
  } else if (
    options.body != null &&
    options.contentType &&
    options.contentType !== "multipart/form-data"
  ) {
    headers["Content-Type"] = options.contentType;
  }

  if (expectsJsonResponse) {
    headers.Accept = "application/json";
  }

  return headers;
}

function buildBody(options: RequestOptions): BodyInit | null | undefined {
  if (options.json != null) {
    return JSON.stringify(options.json);
  }

  return options.body;
}
