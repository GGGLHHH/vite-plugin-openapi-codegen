# vite-plugin-openapi-codegen

Generate typed API clients and path builders from an OpenAPI document during Vite builds.

The plugin reads your OpenAPI spec, runs `openapi-typescript`, and emits three files into your target directory:

- `api-types.d.ts` for raw OpenAPI-derived types
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
  api.ts
  client.ts
```

## Real Example Project

This repository includes a real minimal Vite project under `example/` that demonstrates
automatic generation from `vite.config.ts`.

Key files:

- `example/vite.config.ts` wires the plugin into Vite
- `example/openapi.json` is the input spec
- `example/src/http.ts` provides the runtime symbols used by generated clients
- `example/src/generated/*` is generated during build/dev and is gitignored

Run the example build:

```bash
vp build example --config ./example/vite.config.ts
```

Run the example dev server:

```bash
vp example --config ./example/vite.config.ts
```

After either command, generated files are written to:

```text
example/src/generated/
  api-types.d.ts
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
import type { components } from "./api-types";

export function getUser(params: components["schemas"]["UserPath"]): string {
  return `users/${params.user_id}`;
}
```

And a typed client helper:

```ts
import type { components } from "./api-types";

export interface GetUserOptions {
  query?: never;
  path: components["schemas"]["UserPath"];
  body?: never;
  signal?: AbortSignal;
}

export function getUser(
  options: GetUserOptions,
  requestOptions: RuntimeRequestOptions = {},
): Promise<components["schemas"]["UserResponse"]> {
  return requestJson<components["schemas"]["UserResponse"]>(buildGetUserPath(options.path), {
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
```

## Development

```bash
vp install
vp test
vp check
vp pack
```

To validate the real example project as part of local development:

```bash
vp build example --config ./example/vite.config.ts
```
