# vite-plugin-openapi-codegen

Generate typed API clients and path builders from a local or online OpenAPI document during Vite dev runs.

The plugin reads your OpenAPI JSON or YAML spec, runs `openapi-typescript`, and emits three files into your target directory:

- `api-types.d.ts` for raw OpenAPI-derived types
- `api.ts` for path builder functions
- `client.ts` for typed request helpers
- `access-policies.ts` for per-operation access policies, when the spec declares security — scopes in one requirement are ANDed (`permissions`), multiple requirements are ORed (`anyOf`, one AND-group per branch); grant check: `anyOf ? anyOf.some((g) => g.every(has)) : permissions.every(has)`

It also regenerates local input specs through Vite HMR when the spec changes. In dev mode, generation runs in the background so Vite can finish starting even if the remote spec is temporarily unavailable. Online `http://` and `https://` inputs are fetched once when Vite starts. Build mode skips the plugin entirely. For manual generation, the package also ships a `vg` CLI that reads your local `vite.config.*` and runs the same generator once.

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

If you want to reuse the same configuration outside Vite, run the CLI from the project root:

```bash
vg
```

By default, `vg` searches for `vite.config.ts`, `vite.config.mts`, `vite.config.js`, `vite.config.mjs`, `vite.config.cjs`, or `vite.config.cts` in the current working directory. It reads the `openapiCodegen(...)` plugin options from that file, then generates once with those values.

You can also pass explicit flags. CLI flags always win over the config file:

```bash
vg --root ./example/local
vg --input openapi.yaml --output src/generated
vg --path-prefix /v1/ --type-aliases
```

Online YAML inputs use the same option:

```ts
import { defineConfig } from "vite-plus";
import { openapiCodegen } from "vite-plugin-openapi-codegen";

export default defineConfig({
  plugins: [
    openapiCodegen({
      input: "https://example.com/openapi.yaml",
      output: "src/generated",
    }),
  ],
});
```

When you run `vp dev`, the plugin generates:

```text
src/generated/
  api-types.d.ts
  api.ts
  client.ts
```

## Example Projects

This repository includes two minimal Vite demos under `example/`:

- `example/local` demonstrates generation from the shared local file `example/openapi.json`
- `example/online` demonstrates generation from `http://localhost:8080/openapi.yaml`
- Both demos reuse the shared runtime helper in `example/src/http.ts`

Run the local demo in dev mode:

```bash
vp dev example/local --config ./example/local/vite.config.ts
```

Run the online demo in dev mode:

```bash
vp dev example/online --config ./example/online/vite.config.ts
```

Start both demos together with the shared mock OpenAPI server:

```bash
vp run dev:examples
```

Build either demo shell without running code generation:

```bash
vp build example/local --config ./example/local/vite.config.ts
vp build example/online --config ./example/online/vite.config.ts
```

When you run the dev server, generated files are written to `example/<demo>/src/generated/` and are ignored by git.

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

If you want shorter generated type references, enable `typeAliases`. This keeps the type name suffixes, but avoids long chains like `components["schemas"]["CreateUserRequest"]` and `operations["list_users"]["parameters"]["query"]` in the generated output:

```ts
import { defineConfig } from "vite-plus";
import { openapiCodegen } from "vite-plugin-openapi-codegen";

export default defineConfig({
  plugins: [
    openapiCodegen({
      input: "openapi.json",
      output: "src/generated",
      typeAliases: true,
    }),
  ],
});
```

When enabled, the plugin writes the raw OpenAPI types to `api-types.d.ts` and adds top-level aliases for schema and operation types that the generated `api.ts` and `client.ts` files import directly.

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
- `application/octet-stream` request bodies become `options.body` with `contentType: "application/octet-stream"`
- `multipart/form-data` request bodies become `options.body` as `FormData`
- JSON responses become typed `Promise<T>`
- empty responses use the configured void request function

## Options

```ts
interface Options {
  input: string;
  output: string;
  pathPrefix?: string;
  stripPrefix?: boolean;
  typeAliases?: boolean;
  generateOnDev?: boolean;
  generateOnHmr?: boolean;
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

Path or URL to the OpenAPI JSON/YAML document. Local paths are resolved relative to the Vite project root and watched in dev mode. Online `http://` and `https://` URLs are fetched once at startup and are not watched. The `vg` CLI reads this value from `vite.config.*` when present, unless you override it with `--input`.

In dev mode, generation errors are logged and do not stop Vite from starting. In build mode, the plugin is skipped entirely.

### `generateOnDev`

Controls whether the plugin generates artifacts automatically when the Vite dev server starts. The default is `true`. Set it to `false` when you want dev startup to avoid touching generated files and rely on `vg` or another explicit generation step instead. This option only affects the Vite dev lifecycle; the `vg` CLI still generates when invoked.

### `generateOnHmr`

Controls whether the plugin regenerates artifacts through Vite HMR when a local OpenAPI input file changes. The default is `true`. Set it to `false` when local spec edits should not automatically rewrite generated files during an active dev session. Online `http://` and `https://` inputs are still not watched.

### `output`

Directory where generated files are written, relative to the Vite project root. The `vg` CLI reads this value from `vite.config.*` when present, unless you override it with `--output`.

### `pathPrefix`

Only paths starting with this prefix are included. The default is `"/api/"`. The `vg` CLI reads this value from `vite.config.*` when present, unless you override it with `--path-prefix`.

### `stripPrefix`

Controls whether the `pathPrefix` is removed from generated path builders. The default is `true`. The `vg` CLI reads this value from `vite.config.*` when present, unless you override it with `--strip-prefix` or `--no-strip-prefix`.

### `typeAliases`

When enabled, the plugin generates top-level aliases for schema and operation types and makes the emitted `api.ts` and `client.ts` import those shorter names. The suffixes stay intact, so generated names remain readable while avoiding long `components["schemas"][...]` and `operations["..."][...]` chains. The default is `false` to preserve existing output. The `vg` CLI reads this value from `vite.config.*` when present, unless you override it with `--type-aliases` or `--no-type-aliases`.

### `httpClient`

Overrides the runtime import path and symbol names used by generated clients. The `vg` CLI reads this object from `vite.config.*` when present, unless you override the corresponding HTTP client flags.

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
vp build example/local --config ./example/local/vite.config.ts
vp build example/online --config ./example/online/vite.config.ts
```
