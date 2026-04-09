# vite-plugin-openapi-codegen

Generate typed API clients and path builders from an OpenAPI document during Vite builds.

The plugin reads your OpenAPI spec, runs `openapi-typescript`, and emits four files into your target directory:

- `api-types.d.ts` for raw OpenAPI-derived types
- `types.ts` for schema aliases
- `api.ts` for path builder functions
- `client.ts` for typed request helpers

It also watches the input spec in dev mode and regenerates the files when the spec changes.

## Installation

This package is built for `vite-plus`.

```bash
vp add -D vite-plugin-openapi-codegen vite-plus
```

## Usage

Add the plugin to your Vite config:

```ts
import { defineConfig } from "vite-plus";
import { openapiCodegen } from "vite-plugin-openapi-codegen";

export default defineConfig({
  plugins: [
    openapiCodegen({
      input: "openapi.json",
      output: "src/generated",
    }),
  ],
});
```

When you run `vp dev` or `vp build`, the plugin generates:

```text
src/generated/
  api-types.d.ts
  types.ts
  api.ts
  client.ts
```

## Runtime Contract

By default, generated clients import the following symbols from `#/integrations/http`:

- `requestJson`
- `requestVoid`
- `ApiRequestOptions`

The default runtime shape is designed for an app-level HTTP wrapper like this:

```ts
export interface ApiRequestOptions {
  headers?: Record<string, string>;
  json?: unknown;
  method: string;
  searchParams?: URLSearchParams;
  signal?: AbortSignal;
}

export async function requestJson<T>(path: string, options: ApiRequestOptions): Promise<T> {
  // Your app-specific HTTP implementation
  throw new Error("Not implemented");
}

export async function requestVoid(path: string, options: ApiRequestOptions): Promise<void> {
  // Your app-specific HTTP implementation
  throw new Error("Not implemented");
}
```

If your runtime uses different symbol names or a different module path, configure `httpClient`:

```ts
import { defineConfig } from "vite-plus";
import { openapiCodegen } from "vite-plugin-openapi-codegen";

export default defineConfig({
  plugins: [
    openapiCodegen({
      input: "openapi.json",
      output: "src/generated",
      httpClient: {
        module: "@app/http",
        jsonFunction: "fetchJson",
        voidFunction: "fetchVoid",
        requestOptionsType: "RequestOptions",
        omitKeys: ["json", "method", "signal"],
      },
    }),
  ],
});
```

## Generated Output

Given a spec path like `/api/users/{user_id}`, the plugin generates a path builder:

```ts
export function getUser(params: UserPath): string {
  return `users/${params.user_id}`;
}
```

And a typed client helper:

```ts
export interface GetUserOptions {
  query?: never;
  path: UserPath;
  body?: never;
  signal?: AbortSignal;
}

export function getUser(
  options: GetUserOptions,
  requestOptions: RuntimeRequestOptions = {},
): Promise<UserResponse> {
  return requestJson<UserResponse>(buildGetUserPath(options.path), {
    ...requestOptions,
    method: "GET",
    signal: options.signal,
  });
}
```

The generated client shape depends on the OpenAPI operation:

- path parameters become `options.path`
- query parameters become `options.query`
- JSON request bodies become `options.body`
- JSON responses become typed `Promise<T>`
- empty responses use the configured void request function

## Options

```ts
interface Options {
  input: string;
  output: string;
  pathPrefix?: string;
  stripPrefix?: boolean;
  httpClient?: {
    module?: string;
    jsonFunction?: string;
    voidFunction?: string;
    requestOptionsType?: string;
    omitKeys?: string[];
  };
  legacyAliases?: Record<string, string>;
}
```

### `input`

Path to the OpenAPI JSON file, relative to the Vite project root.

### `output`

Directory where generated files are written, relative to the Vite project root.

### `pathPrefix`

Only paths starting with this prefix are included. The default is `"/api/"`.

### `stripPrefix`

Controls whether the `pathPrefix` is removed from generated path builders. The default is `true`.

### `httpClient`

Overrides the runtime import path and symbol names used by generated clients.

### `legacyAliases`

Adds extra type aliases to `types.ts` so you can preserve older type names during migrations.

## Programmatic Usage

If you want to generate artifacts outside the Vite lifecycle, use `renderGeneratedArtifacts`:

```ts
import { readFileSync } from "node:fs";
import { renderGeneratedArtifacts } from "vite-plugin-openapi-codegen";

const spec = JSON.parse(readFileSync("openapi.json", "utf-8"));

const files = renderGeneratedArtifacts(spec, {
  pathPrefix: "/api/",
  stripPrefix: true,
});

console.log(files.api);
console.log(files.client);
console.log(files.types);
```

## Development

```bash
vp install
vp test
vp check
vp pack
```
