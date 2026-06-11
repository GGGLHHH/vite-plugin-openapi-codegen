import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as ts from "typescript";
import { describe, expect, it, vi } from "vite-plus/test";

import { openapiCodegen, renderGeneratedArtifacts } from "../src/plugin.ts";

describe("vite-plugin-openapi-codegen", () => {
  it("generates path builders and typed request client functions", () => {
    const files = renderGeneratedArtifacts(createSpec(), {});
    const normalizedApi = normalizeGeneratedSource(files.api);
    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(Object.keys(files).sort()).toEqual(["api", "client"]);

    expect(normalizedApi).toContain("export function login(): string {");
    expect(normalizedApi).toContain("export function getItem(");
    expect(normalizedApi).toContain("export function searchExamples(): string {");
    expect(files.api).not.toContain("buildQuery");
    expect(normalizedApi).toContain("import type { components } from './api-types'");
    expect(normalizedApi).toContain("params: components['schemas']['CatalogItemPath']");
    expect(normalizedApi).not.toContain("from './types'");

    expect(normalizedClient).toContain(
      "import type { ApiRequestOptions } from '#/integrations/http'",
    );
    expect(normalizedClient).toContain(
      "import { requestJson, requestVoid } from '#/integrations/http'",
    );
    expect(normalizedClient).toContain("from './api-types'");
    expect(normalizedClient).toContain("components['schemas']['AuthResponse']");
    expect(normalizedClient).toContain("operations['create_review']['parameters']['query']");
    expect(normalizedClient).toContain("Promise<components['schemas']['AuthResponse']>");
    expect(normalizedClient).toContain("Promise<components['schemas']['CatalogItemResponse']>");
    expect(normalizedClient).toContain("Promise<components['schemas']['ExampleSearchResponse']>");
    expect(normalizedClient).toContain("body: components['schemas']['LoginRequest']");
    expect(normalizedClient).toContain("body: components['schemas']['ReviewRequest']");
    expect(normalizedClient).toContain("Promise<components['schemas']['ReviewResponse']>");
    expect(normalizedClient).not.toContain("from './types'");
    expect(normalizedClient).toContain("from './api'");

    expect(normalizedClient).toContain("export interface LoginOptions {");
    expect(normalizedClient).toContain("query?: never");
    expect(normalizedClient).toContain("path?: never");
    expect(normalizedClient).toContain("body: components['schemas']['LoginRequest']");
    expect(normalizedClient).toContain("signal?: AbortSignal");
    expect(normalizedClient).toContain("): Promise<components['schemas']['AuthResponse']> {");
    expect(files.client).not.toContain(
      "operations['login']['requestBody']['content']['application/json']",
    );
    expect(files.client).not.toContain(
      "operations['login']['responses'][200]['content']['application/json']",
    );

    expect(normalizedClient).toContain("export interface SearchExamplesOptions {");
    expect(normalizedClient).toContain("query: components['schemas']['ExampleSearchQuery']");
    expect(normalizedClient).toContain(
      "): Promise<components['schemas']['ExampleSearchResponse']> {",
    );

    expect(normalizedClient).toContain("export interface GetItemOptions {");
    expect(normalizedClient).toContain("path: components['schemas']['CatalogItemPath']");
    expect(normalizedClient).toContain(
      "): Promise<components['schemas']['CatalogItemResponse']> {",
    );

    expect(normalizedClient).toContain("export interface CreateReviewOptions {");
    expect(normalizedClient).toContain("path: components['schemas']['OrderPath']");
    expect(normalizedClient).toContain(
      "query?: operations['create_review']['parameters']['query']",
    );
    expect(normalizedClient).toContain("body: components['schemas']['ReviewRequest']");
    expect(normalizedClient).toContain("): Promise<components['schemas']['ReviewResponse']> {");

    expect(normalizedClient).toContain("export interface LogoutOptions {");
    expect(normalizedClient).toContain("return requestVoid(");
    expect(normalizedClient).toContain("searchParams: buildSearchParams(options.query)");

    expectValidTypeScript(files.api, "api.ts");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("generates access policy artifacts from security requirements", () => {
    const files = renderGeneratedArtifacts(
      {
        components: {
          securitySchemes: {
            bearerAuth: { scheme: "bearer", type: "http" },
            internalToken: { in: "header", type: "apiKey" },
          },
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/api/admin/projects": {
            get: {
              operationId: "list-projects",
              responses: { 200: { description: "OK" } },
              security: [{ bearerAuth: ["admin", "creator"] }],
              tags: ["projects"],
            },
          },
          "/api/auth/me": {
            get: {
              operationId: "get-me",
              responses: { 200: { description: "OK" } },
              tags: ["auth"],
            },
          },
          "/api/public/projects": {
            get: {
              operationId: "list-public-projects",
              responses: { 200: { description: "OK" } },
              security: [],
              tags: ["projects"],
            },
          },
        },
      },
      {},
    );
    const normalizedAccessPolicies = normalizeGeneratedSource(files.accessPolicies ?? "");

    expect(Object.keys(files).sort()).toEqual(["accessPolicies", "api", "client"]);
    expect(normalizedAccessPolicies).toContain("export type AccessPolicyKind =");
    expect(normalizedAccessPolicies).toContain("export interface OperationAccessPolicy");
    expect(normalizedAccessPolicies).toContain("export const accessPolicies = {");
    expect(normalizedAccessPolicies).toContain("listProjects: {");
    expect(normalizedAccessPolicies).toContain("kind: 'role'");
    expect(normalizedAccessPolicies).toContain("roles: ['admin', 'creator']");
    expect(normalizedAccessPolicies).toContain("operationId: 'list-projects'");
    expect(normalizedAccessPolicies).toContain("method: 'GET'");
    expect(normalizedAccessPolicies).toContain("apiPath: '/api/admin/projects'");
    expect(normalizedAccessPolicies).toContain("path: 'admin/projects'");
    expect(normalizedAccessPolicies).toContain("getMe: {");
    expect(normalizedAccessPolicies).toContain("kind: 'authenticated'");
    expect(normalizedAccessPolicies).toContain("listPublicProjects: {");
    expect(normalizedAccessPolicies).toContain("kind: 'public'");
    expectValidTypeScript(files.accessPolicies ?? "", "access-policies.ts");
  });

  it("treats cookie apiKey schemes as the user session when reading security", () => {
    const files = renderGeneratedArtifacts(
      {
        components: {
          securitySchemes: {
            bearerAuth: { in: "cookie", name: "access_token", type: "apiKey" },
            internalToken: { in: "header", name: "Authorization", type: "apiKey" },
          },
        },
        security: [{ bearerAuth: [] }],
        paths: {
          "/api/admin/projects": {
            get: {
              operationId: "list-projects",
              responses: { 200: { description: "OK" } },
              security: [{ bearerAuth: ["admin", "creator"] }],
              tags: ["projects"],
            },
          },
          "/api/auth/me": {
            get: {
              operationId: "get-me",
              responses: { 200: { description: "OK" } },
              tags: ["auth"],
            },
          },
          "/api/internal/roles": {
            post: {
              operationId: "sync-roles",
              responses: { 200: { description: "OK" } },
              security: [{ internalToken: [] }],
              tags: ["internal"],
            },
          },
          "/api/public/projects": {
            get: {
              operationId: "list-public-projects",
              responses: { 200: { description: "OK" } },
              security: [],
              tags: ["projects"],
            },
          },
        },
      },
      {},
    );
    const normalizedAccessPolicies = normalizeGeneratedSource(files.accessPolicies ?? "");

    expect(normalizedAccessPolicies).toContain("listProjects: {");
    expect(normalizedAccessPolicies).toContain("kind: 'role'");
    expect(normalizedAccessPolicies).toContain("roles: ['admin', 'creator']");
    expect(normalizedAccessPolicies).toContain("getMe: {");
    expect(normalizedAccessPolicies).toContain("kind: 'authenticated'");
    expect(normalizedAccessPolicies).toContain("syncRoles: {");
    expect(normalizedAccessPolicies).toContain("kind: 'internal'");
    expect(normalizedAccessPolicies).toContain("listPublicProjects: {");
    expect(normalizedAccessPolicies).toContain("kind: 'public'");
    expectValidTypeScript(files.accessPolicies ?? "", "access-policies.ts");
  });

  it("supports custom pathPrefix for filtering and stripping", () => {
    const spec = {
      components: {
        schemas: {
          Item: { properties: { id: { type: "string" } }, type: "object" },
        },
      },
      paths: {
        "/v1/items": {
          get: {
            operationId: "list_items",
            responses: { 200: { description: "OK" } },
            tags: ["items"],
          },
        },
        "/api/ignored": {
          get: {
            operationId: "ignored",
            responses: { 200: { description: "OK" } },
            tags: ["other"],
          },
        },
      },
    };

    const files = renderGeneratedArtifacts(spec, { pathPrefix: "/v1/" });
    const normalizedApi = normalizeGeneratedSource(files.api);

    expect(normalizedApi).toContain("export function listItems(): string {");
    expect(normalizedApi).toContain("return 'items'");
    expect(normalizedApi).not.toContain("ignored");
    expectValidTypeScript(files.api, "api.ts");
  });

  it("generates repeated query keys for array query parameters", () => {
    const spec = {
      paths: {
        "/api/projects": {
          get: {
            operationId: "list_projects",
            parameters: [
              {
                in: "query",
                name: "status",
                required: false,
                schema: {
                  items: { type: "string" },
                  type: "array",
                },
              },
              {
                in: "query",
                name: "limit",
                required: false,
                schema: { type: "integer" },
              },
            ],
            responses: { 204: { description: "OK" } },
            tags: ["projects"],
          },
        },
      },
    } satisfies Parameters<typeof renderGeneratedArtifacts>[0];
    const files = renderGeneratedArtifacts(spec, {});
    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(normalizedClient).toContain(
      "query?: operations['list_projects']['parameters']['query']",
    );
    expect(normalizedClient).toContain("Array.isArray(value)");
    expect(normalizedClient).toContain("searchParams.append(key, String(item))");
    expect(normalizedClient).toContain("searchParams.set(key, String(value))");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("generates top-level type aliases when enabled", () => {
    const files = renderGeneratedArtifacts(createSpec(), { typeAliases: true });
    const normalizedApi = normalizeGeneratedSource(files.api);
    const normalizedApiTypes = normalizeGeneratedSource(files.apiTypes ?? "");
    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(Object.keys(files).sort()).toEqual(["api", "apiTypes", "client"]);
    expect(normalizedApi).toContain(
      "import type { CatalogItemPath, OrderPath } from './api-types'",
    );
    expect(normalizedApi).toContain("params: CatalogItemPath");
    expect(normalizedApi).not.toContain("components['schemas']['CatalogItemPath']");

    expect(normalizedApiTypes).toContain(
      "export type CreateReviewQuery = operations['create_review']['parameters']['query']",
    );

    expect(normalizedClient).toContain(
      "import type { ApiRequestOptions } from '#/integrations/http'",
    );
    expect(normalizedClient).toContain("import type {");
    expect(normalizedClient).toContain("AuthResponse");
    expect(normalizedClient).toContain("CatalogItemPath");
    expect(normalizedClient).toContain("CreateReviewQuery");
    expect(normalizedClient).toContain("ExampleSearchQuery");
    expect(normalizedClient).toContain("LoginRequest");
    expect(normalizedClient).toContain("body: LoginRequest");
    expect(normalizedClient).toContain("path: CatalogItemPath");
    expect(normalizedClient).toContain("query: ExampleSearchQuery");
    expect(normalizedClient).toContain("query?: CreateReviewQuery");
    expect(normalizedClient).toContain("): Promise<AuthResponse> {");
    expect(normalizedClient).not.toContain("components['schemas']");
    expect(normalizedClient).not.toContain("operations['");

    expectValidTypeScript(files.api, "api.ts");
    expectValidTypeScript(files.client, "client.ts");
    expectValidTypeScript(createMinimalApiTypesSource(files.apiTypes ?? ""), "api-types.ts");
  });

  it("uses operationId names to avoid collisions across repeated path parameters", () => {
    const files = renderGeneratedArtifacts(
      {
        paths: {
          "/api/admin/projects/{id}": {
            get: {
              operationId: "get-project",
              parameters: [
                {
                  in: "path",
                  name: "id",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: { 204: { description: "OK" } },
              tags: ["projects"],
            },
          },
          "/api/admin/users/{id}": {
            get: {
              operationId: "get-user",
              parameters: [
                {
                  in: "path",
                  name: "id",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: { 204: { description: "OK" } },
              tags: ["users"],
            },
          },
        },
      },
      {},
    );
    const normalizedApi = normalizeGeneratedSource(files.api);
    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(normalizedApi).toContain("export function getProject(");
    expect(normalizedApi).toContain("export function getUser(");
    expect(normalizedApi).not.toContain("export function getAdminId(");
    expect(normalizedClient).toContain("getProject as buildGetProjectPath");
    expect(normalizedClient).toContain("getUser as buildGetUserPath");
    expectValidTypeScript(files.api, "api.ts");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("supports custom httpClient configuration", () => {
    const files = renderGeneratedArtifacts(createSpec(), {
      httpClient: {
        module: "@app/http",
        jsonFunction: "fetchJson",
        voidFunction: "fetchVoid",
        requestOptionsType: "RequestConfig",
        omitKeys: ["body", "method"],
      },
    });
    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(normalizedClient).toContain("import type { RequestConfig } from '@app/http'");
    expect(normalizedClient).toContain("import { fetchJson, fetchVoid } from '@app/http'");
    expect(normalizedClient).toContain("Omit<RequestConfig, 'body' | 'method'>");
    expect(normalizedClient).toContain("return fetchJson<");
    expect(normalizedClient).toContain("return fetchVoid(");
    expect(normalizedClient).not.toContain("requestJson");
    expect(normalizedClient).not.toContain("requestVoid");
    expect(normalizedClient).not.toContain("ApiRequestOptions");
    expect(normalizedClient).not.toContain("#/integrations/http");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("generates non-JSON request bodies for binary and multipart operations", () => {
    const files = renderGeneratedArtifacts(
      {
        components: {
          schemas: {
            MultipartUploadRequest: {
              properties: {
                title: {
                  type: "string",
                },
              },
              type: "object",
            },
          },
        },
        paths: {
          "/api/uploads/binary": {
            put: {
              operationId: "upload_binary",
              requestBody: {
                content: {
                  "application/octet-stream": {
                    schema: {
                      format: "binary",
                      type: "string",
                    },
                  },
                },
                required: true,
              },
              responses: {
                200: {
                  description: "OK",
                },
              },
              tags: ["uploads"],
            },
          },
          "/api/uploads/multipart": {
            post: {
              operationId: "upload_multipart",
              requestBody: {
                content: {
                  "multipart/form-data": {
                    schema: {
                      $ref: "#/components/schemas/MultipartUploadRequest",
                    },
                  },
                },
                required: true,
              },
              responses: {
                200: {
                  description: "OK",
                },
              },
              tags: ["uploads"],
            },
          },
        },
      },
      {},
    );

    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(normalizedClient).toContain("body: Blob | File | ArrayBuffer | string");
    expect(normalizedClient).toContain("body: FormData");
    expect(normalizedClient).toContain("contentType: 'application/octet-stream'");
    expect(normalizedClient).toContain("body: options.body");
    expect(normalizedClient).not.toContain("contentType: 'multipart/form-data'");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("keeps binary request bodies valid when type aliases are enabled", () => {
    const files = renderGeneratedArtifacts(
      {
        paths: {
          "/api/uploads/binary": {
            put: {
              operationId: "upload_binary",
              requestBody: {
                content: {
                  "application/octet-stream": {
                    schema: {
                      format: "binary",
                      type: "string",
                    },
                  },
                },
                required: true,
              },
              responses: {
                200: {
                  description: "OK",
                },
              },
              tags: ["uploads"],
            },
          },
        },
      },
      { typeAliases: true },
    );

    const normalizedClient = normalizeGeneratedSource(files.client);
    const normalizedApiTypes = normalizeGeneratedSource(files.apiTypes ?? "");

    expect(normalizedClient).toContain("body: UploadBinaryRequest");
    expect(normalizedClient).toContain("contentType: 'application/octet-stream'");
    expect(normalizedClient).toContain("import type { UploadBinaryRequest } from './api-types'");
    expect(normalizedApiTypes).toContain(
      "export type UploadBinaryRequest = Blob | File | ArrayBuffer | string",
    );
    expectValidTypeScript(files.apiTypes ?? "", "api-types.ts");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("treats optional request bodies as optional client options", () => {
    const files = renderGeneratedArtifacts(
      {
        components: {
          schemas: {
            RefreshRequest: {
              properties: {
                refresh_token: {
                  type: "string",
                },
              },
              required: ["refresh_token"],
              type: "object",
            },
            TokenResponse: {
              properties: {
                token_type: {
                  type: "string",
                },
              },
              required: ["token_type"],
              type: "object",
            },
          },
        },
        paths: {
          "/api/auth/refresh": {
            post: {
              operationId: "refresh_token",
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/RefreshRequest",
                    },
                  },
                },
                required: false,
              },
              responses: {
                200: {
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/TokenResponse",
                      },
                    },
                  },
                  description: "OK",
                },
              },
              tags: ["auth"],
            },
          },
        },
      },
      { typeAliases: true },
    );

    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(normalizedClient).toContain("body?: RefreshRequest");
    expect(normalizedClient).toContain(
      "...(options.body === undefined ? {} : { json: options.body })",
    );
    expectValidTypeScript(files.client, "client.ts");
  });

  it("generates artifacts from an online YAML OpenAPI URL at startup", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const outputDir = resolve(tempRoot, "generated");
    const server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "application/yaml" });
      response.end(createYamlSpec());
    });

    try {
      const input = await listen(server);
      const plugin = openapiCodegen({
        input,
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }

      await callConfigResolved(plugin, tempRoot, "serve");
      await plugin.buildStart.call({} as never, {} as never);

      await waitForFiles(outputDir, ["api-types.d.ts", "api.ts", "client.ts"]);

      const generatedApi = readFileSync(resolve(outputDir, "api.ts"), "utf-8");
      expect(normalizeGeneratedSource(generatedApi)).toContain(
        "export function getRemoteStatus(): string {",
      );
    } finally {
      await closeServer(server);
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("writes access policy artifacts during generation", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const outputDir = resolve(tempRoot, "generated");
    writeFileSync(resolve(tempRoot, "openapi.yaml"), createYamlSpecWithAccessPolicy());

    try {
      const plugin = openapiCodegen({
        input: "openapi.yaml",
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }

      await callConfigResolved(plugin, tempRoot, "serve");
      await plugin.buildStart.call({} as never, {} as never);

      await waitForFiles(outputDir, [
        "access-policies.ts",
        "api-types.d.ts",
        "api.ts",
        "client.ts",
      ]);

      const generatedAccessPolicies = readFileSync(
        resolve(outputDir, "access-policies.ts"),
        "utf-8",
      );
      expect(normalizeGeneratedSource(generatedAccessPolicies)).toContain("getRemoteStatus: {");
      expect(normalizeGeneratedSource(generatedAccessPolicies)).toContain("kind: 'role'");
      expect(normalizeGeneratedSource(generatedAccessPolicies)).toContain(
        "roles: ['admin', 'creator']",
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not block dev startup when online generation fails", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const server = createServer((_, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("not ready");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const input = await listen(server);
      const plugin = openapiCodegen({
        input,
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }

      await callConfigResolved(plugin, tempRoot, "serve");
      await expect(plugin.buildStart.call({} as never, {} as never)).resolves.toBeUndefined();
      await waitForCall(consoleErrorSpy);
    } finally {
      consoleErrorSpy.mockRestore();
      await closeServer(server);
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("skips dev startup generation when disabled", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const outputDir = resolve(tempRoot, "generated");
    writeFileSync(resolve(tempRoot, "openapi.yaml"), createYamlSpec());

    try {
      const plugin = openapiCodegen({
        generateOnDev: false,
        input: "openapi.yaml",
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }

      await callConfigResolved(plugin, tempRoot, "serve");
      await plugin.buildStart.call({} as never, {} as never);

      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("regenerates generated files through Vite HMR for local inputs", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const inputPath = resolve(tempRoot, "openapi.yaml");
    const outputDir = resolve(tempRoot, "generated");
    writeFileSync(inputPath, createYamlSpec());

    try {
      const plugin = openapiCodegen({
        input: "openapi.yaml",
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }
      if (typeof plugin.handleHotUpdate !== "function") {
        throw new Error("Expected handleHotUpdate hook");
      }

      await callConfigResolved(plugin, tempRoot, "serve");
      await plugin.buildStart.call({} as never, {} as never);
      await waitForFiles(outputDir, ["api-types.d.ts", "api.ts", "client.ts"]);

      writeFileSync(inputPath, createYamlSpec().replaceAll("status", "health"));

      await expect(
        plugin.handleHotUpdate.call(
          {} as never,
          {
            file: inputPath,
            modules: [],
            read: () => readFileSync(inputPath, "utf-8"),
            server: {} as never,
            timestamp: Date.now(),
          } as never,
        ),
      ).resolves.toBeUndefined();

      const generatedApi = readFileSync(resolve(outputDir, "api.ts"), "utf-8");
      expect(normalizeGeneratedSource(generatedApi)).toContain(
        "export function getRemoteHealth(): string {",
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("skips HMR regeneration when disabled", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const inputPath = resolve(tempRoot, "openapi.yaml");
    const outputDir = resolve(tempRoot, "generated");
    writeFileSync(inputPath, createYamlSpec());

    try {
      const plugin = openapiCodegen({
        generateOnHmr: false,
        input: "openapi.yaml",
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }
      if (typeof plugin.handleHotUpdate !== "function") {
        throw new Error("Expected handleHotUpdate hook");
      }

      await callConfigResolved(plugin, tempRoot, "serve");
      await plugin.buildStart.call({} as never, {} as never);
      await waitForFiles(outputDir, ["api-types.d.ts", "api.ts", "client.ts"]);

      writeFileSync(inputPath, createYamlSpec().replaceAll("status", "health"));

      await expect(
        plugin.handleHotUpdate.call(
          {} as never,
          {
            file: inputPath,
            modules: [],
            read: () => readFileSync(inputPath, "utf-8"),
            server: {} as never,
            timestamp: Date.now(),
          } as never,
        ),
      ).resolves.toBeUndefined();

      const generatedApi = readFileSync(resolve(outputDir, "api.ts"), "utf-8");
      expect(normalizeGeneratedSource(generatedApi)).toContain(
        "export function getRemoteStatus(): string {",
      );
      expect(normalizeGeneratedSource(generatedApi)).not.toContain(
        "export function getRemoteHealth(): string {",
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("skips generation entirely during build mode", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "application/yaml" });
      response.end(createYamlSpec());
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const input = await listen(server);
      const plugin = openapiCodegen({
        input,
        output: "generated",
      });

      if (typeof plugin.configResolved !== "function") {
        throw new Error("Expected configResolved hook");
      }
      if (typeof plugin.buildStart !== "function") {
        throw new Error("Expected buildStart hook");
      }

      await callConfigResolved(plugin, tempRoot, "build");
      await plugin.buildStart.call({} as never, {} as never);

      expect(existsSync(resolve(tempRoot, "generated"))).toBe(false);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      await closeServer(server);
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("CLI generates from the openapiCodegen config in vite.config.ts", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const outputDir = resolve(tempRoot, "generated");
    writeFileSync(resolve(tempRoot, "openapi.yaml"), createYamlSpec());
    writeFileSync(
      resolve(tempRoot, "vite.config.ts"),
      createViteConfigSource({
        input: "openapi.yaml",
        output: "generated",
      }),
    );

    try {
      await linkVitePlusDependency(tempRoot);
      runCli(["--root", tempRoot]);

      const generatedApi = readFileSync(resolve(outputDir, "api.ts"), "utf-8");
      expect(normalizeGeneratedSource(generatedApi)).toContain(
        "export function getRemoteStatus(): string {",
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("CLI explicit options override openapiCodegen config", async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "openapi-codegen-"));
    const configuredOutputDir = resolve(tempRoot, "configured-generated");
    const explicitOutputDir = resolve(tempRoot, "explicit-generated");
    writeFileSync(resolve(tempRoot, "configured.yaml"), createYamlSpec());
    writeFileSync(
      resolve(tempRoot, "explicit.yaml"),
      createYamlSpec().replaceAll("status", "health"),
    );
    writeFileSync(
      resolve(tempRoot, "vite.config.ts"),
      createViteConfigSource({
        input: "configured.yaml",
        output: "configured-generated",
      }),
    );

    try {
      await linkVitePlusDependency(tempRoot);
      runCli(["--root", tempRoot, "--input", "explicit.yaml", "--output", "explicit-generated"]);

      expect(existsSync(configuredOutputDir)).toBe(false);
      const generatedApi = readFileSync(resolve(explicitOutputDir, "api.ts"), "utf-8");
      expect(normalizeGeneratedSource(generatedApi)).toContain(
        "export function getRemoteHealth(): string {",
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("type-aware lint accepts web globals in the example runtime helper", () => {
    expect(() =>
      execFileSync(
        "vp",
        ["lint", "--type-aware", "--tsconfig", "./tsconfig.json", "example/src/http.ts"],
        {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });

  it("builds both demos as real vite projects without running code generation", () => {
    cleanupExampleArtifacts();

    try {
      for (const exampleName of ["local", "online"] as const) {
        const { distDir, generatedDir } = getExamplePaths(exampleName);

        buildExampleProject(exampleName);

        expect(existsSync(resolve(distDir, "index.html"))).toBe(true);
        expect(existsSync(resolve(generatedDir))).toBe(false);
      }
    } finally {
      cleanupExampleArtifacts();
    }
  });

  it("keeps both demo tsconfig files type-safe", () => {
    cleanupExampleArtifacts();

    try {
      expect(getProjectTypeErrors("example/local/tsconfig.json")).toEqual([]);
      expect(getProjectTypeErrors("example/online/tsconfig.json")).toEqual([]);
    } finally {
      cleanupExampleArtifacts();
    }
  });

  it("retains full path when stripPrefix is false", () => {
    const files = renderGeneratedArtifacts(createSpec(), { stripPrefix: false });
    const normalizedApi = normalizeGeneratedSource(files.api);

    expect(normalizedApi).toContain("return '/api/auth/login'");
    expect(normalizedApi).toContain("return `/api/catalog/items/${params.item_id}`");
    expectValidTypeScript(files.api, "api.ts");
  });

  it("generates RuntimeRequestOptions without Omit when omitKeys is empty", () => {
    const files = renderGeneratedArtifacts(createSpec(), {
      httpClient: { omitKeys: [] },
    });
    const normalizedClient = normalizeGeneratedSource(files.client);

    expect(normalizedClient).toContain("type RuntimeRequestOptions = ApiRequestOptions");
    expect(normalizedClient).not.toContain("Omit<");
    expectValidTypeScript(files.client, "client.ts");
  });

  it("throws with custom pathPrefix in error message when no paths match", () => {
    const spec = {
      components: {
        schemas: { Item: { properties: { id: { type: "string" } }, type: "object" } },
      },
      paths: {
        "/api/items": {
          get: {
            operationId: "list_items",
            responses: { 200: { description: "OK" } },
            tags: ["items"],
          },
        },
      },
    };

    expect(() => renderGeneratedArtifacts(spec, { pathPrefix: "/v2/" })).toThrow(
      'No paths matching prefix "/v2/" found',
    );
  });

  it("maintains proper module boundaries", () => {
    const pluginSourceText = readFileSync(
      resolve(import.meta.dirname, "../src/plugin.ts"),
      "utf-8",
    );
    const astSourceText = readFileSync(resolve(import.meta.dirname, "../src/ast.ts"), "utf-8");
    const normalizationSourceText = readFileSync(
      resolve(import.meta.dirname, "../src/normalization.ts"),
      "utf-8",
    );

    // Plugin entry imports from ast and normalization directly
    expect(pluginSourceText).toContain('from "./ast.ts"');
    expect(pluginSourceText).toContain('from "./normalization.ts"');

    // Plugin entry exports HttpClientConfig
    expect(pluginSourceText).toContain("export interface HttpClientConfig");

    // Plugin entry does NOT contain AST internals
    expect(pluginSourceText).not.toContain('import * as ts from "typescript"');
    expect(pluginSourceText).not.toContain("function printGeneratedFile(");
    expect(pluginSourceText).not.toContain("function createBuildSearchParamsFunction(");

    // AST module imports from normalization for shared types
    expect(astSourceText).toContain('from "./normalization.ts"');

    // Normalization exports key public functions
    expect(normalizationSourceText).toContain(
      "export function buildClientRenderModelFromOperations(",
    );
    expect(normalizationSourceText).toContain("export function collectOperations(");
    expect(normalizationSourceText).toContain("export function warnOnParameterLocationMismatch(");
  });
});

function expectValidTypeScript(sourceText: string, fileName: string) {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
    },
    fileName,
    reportDiagnostics: true,
  });

  const diagnostics = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  expect(diagnostics ?? []).toHaveLength(0);
}

function getProjectTypeErrors(projectPath: string): string[] {
  const configPath = resolve(import.meta.dirname, "..", projectPath);
  const readFile = (filePath: string) => ts.sys.readFile(filePath);
  const configFile = ts.readConfigFile(configPath, readFile);

  const configErrors = [
    ...(configFile.error ? [configFile.error] : []),
    ...parseProjectTypeErrors(configPath, configFile.config),
  ];

  return configErrors.map(formatDiagnostic);
}

function parseProjectTypeErrors(configPath: string, config: unknown): readonly ts.Diagnostic[] {
  const parsed = ts.parseJsonConfigFileContent(
    config as Record<string, unknown>,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: parsed.errors,
  });

  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start == null) {
    return message;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}

function normalizeGeneratedSource(sourceText: string): string {
  return sourceText.replaceAll('"', "'").replaceAll(";", "").replace(/\s+/g, " ").trim();
}

function createMinimalApiTypesSource(extraSource: string): string {
  return [
    "export interface components {",
    "  schemas: {",
    "    AuthResponse: { token: string };",
    "    CatalogItemPath: { item_id: string };",
    "    CatalogItemResponse: { item_id: string };",
    "    ExampleSearchQuery: { page: number };",
    "    ExampleSearchResponse: { page: number };",
    "    LoginRequest: { identifier: string };",
    "    OrderPath: { order_id: string };",
    "    ReviewRequest: { rating: number };",
    "    ReviewResponse: { review_id: string };",
    "  };",
    "}",
    "export interface operations {",
    "  create_review: { parameters: { query?: { notify?: boolean } } };",
    "}",
    extraSource,
  ].join("\n");
}

async function callConfigResolved(
  plugin: ReturnType<typeof openapiCodegen>,
  root: string,
  command: "build" | "serve" = "build",
): Promise<void> {
  const hook = plugin.configResolved as (config: {
    command: "build" | "serve";
    root: string;
  }) => void | Promise<void>;
  await hook({ command, root });
}

async function waitForFiles(outputDir: string, fileNames: string[]): Promise<void> {
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (fileNames.every((fileName) => existsSync(resolve(outputDir, fileName)))) {
      return;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }

  throw new Error(`Timed out waiting for generated files in ${outputDir}`);
}

async function waitForCall(spy: { mock: { calls: unknown[][] } }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spy.mock.calls.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Expected spy to be called");
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectReady);
      resolveReady();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve server address");
  }

  return `http://127.0.0.1:${address.port}/openapi.yaml`;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClosed, rejectClosed) => {
    server.close((error) => {
      if (error) {
        rejectClosed(error);
        return;
      }

      resolveClosed();
    });
  });
}

function getExamplePaths(exampleName: "local" | "online") {
  const projectRoot = resolve(import.meta.dirname, "..");
  const exampleRoot = resolve(projectRoot, "example", exampleName);

  return {
    distDir: resolve(exampleRoot, "dist"),
    generatedDir: resolve(exampleRoot, "src/generated"),
    projectRoot,
  };
}

function cleanupExampleArtifacts() {
  const exampleRoot = resolve(import.meta.dirname, "..", "example");

  for (const entry of readdirSync(exampleRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const examplePath = resolve(exampleRoot, entry.name);
    rmSync(resolve(examplePath, "dist"), { force: true, recursive: true });
    rmSync(resolve(examplePath, "src/generated"), { force: true, recursive: true });
  }
}

function buildExampleProject(exampleName: "local" | "online") {
  const { projectRoot } = getExamplePaths(exampleName);

  execFileSync(
    "./node_modules/.bin/vp",
    [
      "build",
      `example/${exampleName}`,
      "--config",
      `./example/${exampleName}/vite.config.ts`,
      "--logLevel",
      "error",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
}

function runCli(args: string[]) {
  execFileSync("node", [resolve(import.meta.dirname, "../src/cli.ts"), ...args], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    stdio: "pipe",
  });
}

async function linkVitePlusDependency(root: string): Promise<void> {
  const nodeModulesDir = resolve(root, "node_modules");
  await mkdir(nodeModulesDir, { recursive: true });
  await symlink(
    resolve(import.meta.dirname, "../node_modules/vite-plus"),
    resolve(nodeModulesDir, "vite-plus"),
    "dir",
  );
}

function createViteConfigSource(options: { input: string; output: string }): string {
  const entryUrl = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;

  return [
    'import { defineConfig } from "vite-plus";',
    `import { openapiCodegen } from ${JSON.stringify(entryUrl)};`,
    "",
    "export default defineConfig({",
    "  plugins: [",
    "    openapiCodegen({",
    `      input: ${JSON.stringify(options.input)},`,
    `      output: ${JSON.stringify(options.output)},`,
    "    }),",
    "  ],",
    "});",
    "",
  ].join("\n");
}

function createYamlSpec(): string {
  return [
    "openapi: 3.0.0",
    "info:",
    "  title: Remote API",
    "  version: 1.0.0",
    "paths:",
    "  /api/remote/status:",
    "    get:",
    "      operationId: get_remote_status",
    "      responses:",
    "        '200':",
    "          description: OK",
    "          content:",
    "            application/json:",
    "              schema:",
    "                $ref: '#/components/schemas/RemoteStatusResponse'",
    "      tags:",
    "        - remote",
    "components:",
    "  schemas:",
    "    RemoteStatusResponse:",
    "      type: object",
    "      properties:",
    "        ok:",
    "          type: boolean",
    "",
  ].join("\n");
}

function createYamlSpecWithAccessPolicy(): string {
  return createYamlSpec()
    .replace(
      "      responses:",
      [
        "      security:",
        "        - bearerAuth:",
        "            - admin",
        "            - creator",
        "      responses:",
      ].join("\n"),
    )
    .replace(
      "components:",
      [
        "components:",
        "  securitySchemes:",
        "    bearerAuth:",
        "      type: http",
        "      scheme: bearer",
      ].join("\n"),
    );
}

function createSpec(): Parameters<typeof renderGeneratedArtifacts>[0] {
  return {
    components: {
      schemas: {
        AuthResponse: {
          properties: {
            token: {
              type: "string",
            },
          },
          type: "object",
        },
        CatalogItemPath: {
          properties: {
            item_id: {
              type: "string",
            },
          },
          type: "object",
        },
        CatalogItemResponse: {
          properties: {
            item_id: {
              type: "string",
            },
          },
          type: "object",
        },
        ExampleSearchQuery: {
          properties: {
            page: {
              type: "integer",
            },
          },
          type: "object",
        },
        ExampleSearchResponse: {
          properties: {
            page: {
              type: "integer",
            },
          },
          type: "object",
        },
        LoginRequest: {
          properties: {
            identifier: {
              type: "string",
            },
          },
          type: "object",
        },
        OrderPath: {
          properties: {
            order_id: {
              type: "string",
            },
          },
          type: "object",
        },
        ReviewRequest: {
          properties: {
            rating: {
              type: "integer",
            },
          },
          type: "object",
        },
        ReviewResponse: {
          properties: {
            review_id: {
              type: "string",
            },
          },
          type: "object",
        },
      },
    },
    paths: {
      "/api/auth/login": {
        post: {
          operationId: "login",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/LoginRequest",
                },
              },
            },
            required: true,
          },
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/AuthResponse",
                  },
                },
              },
            },
          },
          tags: ["auth"],
        },
      },
      "/api/auth/logout": {
        post: {
          operationId: "logout",
          responses: {
            204: {
              description: "Logged out",
            },
          },
          tags: ["auth"],
        },
      },
      "/api/catalog/items/{item_id}": {
        get: {
          operationId: "get_item",
          parameters: [
            {
              in: "path",
              name: "item_id",
              required: true,
              schema: {
                type: "string",
              },
            },
          ],
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CatalogItemResponse",
                  },
                },
              },
            },
          },
          tags: ["catalog"],
        },
      },
      "/api/examples/search": {
        get: {
          operationId: "search_examples",
          parameters: [
            {
              in: "query",
              name: "page",
              required: true,
              schema: {
                type: "integer",
              },
            },
          ],
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ExampleSearchResponse",
                  },
                },
              },
            },
          },
          tags: ["examples"],
        },
      },
      "/api/orders/{order_id}/reviews": {
        post: {
          operationId: "create_review",
          parameters: [
            {
              in: "path",
              name: "order_id",
              required: true,
              schema: {
                type: "string",
              },
            },
            {
              in: "query",
              name: "notify",
              required: false,
              schema: {
                type: "boolean",
              },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ReviewRequest",
                },
              },
            },
            required: true,
          },
          responses: {
            201: {
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReviewResponse",
                  },
                },
              },
            },
          },
          tags: ["orders"],
        },
      },
    },
  };
}
