#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Plugin } from "vite-plus";
import { loadConfigFromFile } from "vite-plus";

import { generateOpenAPIArtifacts } from "./plugin.ts";
import type { HttpClientConfig, Options } from "./plugin.ts";

interface CliFlags {
  config?: string;
  help?: boolean;
  httpClientJsonFunction?: string;
  httpClientModule?: string;
  httpClientOmitKeys?: string[];
  httpClientRequestOptionsType?: string;
  httpClientVoidFunction?: string;
  input?: string;
  output?: string;
  pathPrefix?: string;
  root?: string;
  stripPrefix?: boolean;
  typeAliases?: boolean;
}

interface OpenAPICodegenPlugin extends Plugin {
  api?: { options?: Options };
}

const CONFIG_FILE_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.cts",
];

async function main(argv: string[]): Promise<void> {
  const flags = parseArgs(argv);

  if (flags.help) {
    printHelp();
    return;
  }

  const root = resolve(process.cwd(), flags.root ?? ".");
  const configOptions = await loadOptionsFromViteConfig(root, flags.config);
  const explicitOptions = createOptionsFromFlags(flags);
  const options = mergeOptions(configOptions, explicitOptions);

  if (!options.input || !options.output) {
    throw new Error(
      "[openapi-codegen] Missing required options. Provide --input and --output or configure openapiCodegen() in vite.config.",
    );
  }

  await generateOpenAPIArtifacts(root, options);
  console.log(`[openapi-codegen] generated files in ${resolve(root, options.output)}`);
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split("=", 2);

    switch (name) {
      case "--config":
        flags.config = readValue(argv, ++index, inlineValue, name);
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--http-client-json-function":
        flags.httpClientJsonFunction = readValue(argv, ++index, inlineValue, name);
        break;
      case "--http-client-module":
        flags.httpClientModule = readValue(argv, ++index, inlineValue, name);
        break;
      case "--http-client-omit-keys":
        flags.httpClientOmitKeys = parseCommaList(readValue(argv, ++index, inlineValue, name));
        break;
      case "--http-client-request-options-type":
        flags.httpClientRequestOptionsType = readValue(argv, ++index, inlineValue, name);
        break;
      case "--http-client-void-function":
        flags.httpClientVoidFunction = readValue(argv, ++index, inlineValue, name);
        break;
      case "--input":
        flags.input = readValue(argv, ++index, inlineValue, name);
        break;
      case "--output":
        flags.output = readValue(argv, ++index, inlineValue, name);
        break;
      case "--path-prefix":
        flags.pathPrefix = readValue(argv, ++index, inlineValue, name);
        break;
      case "--root":
        flags.root = readValue(argv, ++index, inlineValue, name);
        break;
      case "--strip-prefix":
        flags.stripPrefix = parseBoolean(readValue(argv, ++index, inlineValue, name), name);
        break;
      case "--type-aliases":
        flags.typeAliases = true;
        break;
      case "--no-strip-prefix":
        flags.stripPrefix = false;
        break;
      case "--no-type-aliases":
        flags.typeAliases = false;
        break;
      default:
        throw new Error(`[openapi-codegen] Unknown option: ${arg}`);
    }

    if (inlineValue !== undefined) {
      index--;
    }
  }

  return flags;
}

function readValue(
  argv: string[],
  index: number,
  inlineValue: string | undefined,
  name: string,
): string {
  if (inlineValue !== undefined) {
    return inlineValue;
  }

  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`[openapi-codegen] Missing value for ${name}`);
  }

  return value;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`[openapi-codegen] Expected ${name} to be true or false`);
}

function parseCommaList(value: string): string[] {
  if (value.length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function loadOptionsFromViteConfig(
  root: string,
  configPath?: string,
): Promise<Partial<Options>> {
  const resolvedConfigPath = resolveViteConfigPath(root, configPath);
  if (!resolvedConfigPath) {
    return {};
  }

  const config = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    resolvedConfigPath,
    root,
    "silent",
  );

  const pluginOptions = extractOpenAPICodegenOptions(config?.config.plugins);
  return pluginOptions ?? {};
}

function resolveViteConfigPath(root: string, configPath?: string): string | undefined {
  if (configPath) {
    const resolved = resolve(root, configPath);
    if (!existsSync(resolved)) {
      throw new Error(`[openapi-codegen] Vite config not found: ${resolved}`);
    }

    return resolved;
  }

  return CONFIG_FILE_NAMES.map((fileName) => resolve(root, fileName)).find((filePath) =>
    existsSync(filePath),
  );
}

function extractOpenAPICodegenOptions(plugins: unknown): Options | undefined {
  const flattened = flattenPlugins(plugins);
  const plugin = flattened.find(isOpenAPICodegenPlugin);
  return plugin?.api?.options;
}

function flattenPlugins(value: unknown): Plugin[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((plugin) => {
    if (Array.isArray(plugin)) {
      return flattenPlugins(plugin);
    }

    if (!plugin || typeof plugin !== "object") {
      return [];
    }

    return [plugin as Plugin];
  });
}

function isOpenAPICodegenPlugin(plugin: Plugin): plugin is OpenAPICodegenPlugin {
  return (
    plugin.name === "openapi-codegen" && Boolean((plugin as OpenAPICodegenPlugin).api?.options)
  );
}

function createOptionsFromFlags(flags: CliFlags): Partial<Options> {
  const httpClient = createHttpClientConfigFromFlags(flags);

  return {
    ...(flags.input ? { input: flags.input } : {}),
    ...(flags.output ? { output: flags.output } : {}),
    ...(flags.pathPrefix ? { pathPrefix: flags.pathPrefix } : {}),
    ...(flags.stripPrefix !== undefined ? { stripPrefix: flags.stripPrefix } : {}),
    ...(flags.typeAliases !== undefined ? { typeAliases: flags.typeAliases } : {}),
    ...(httpClient ? { httpClient } : {}),
  };
}

function createHttpClientConfigFromFlags(flags: CliFlags): HttpClientConfig | undefined {
  const httpClient: HttpClientConfig = {
    ...(flags.httpClientModule ? { module: flags.httpClientModule } : {}),
    ...(flags.httpClientJsonFunction ? { jsonFunction: flags.httpClientJsonFunction } : {}),
    ...(flags.httpClientVoidFunction ? { voidFunction: flags.httpClientVoidFunction } : {}),
    ...(flags.httpClientRequestOptionsType
      ? { requestOptionsType: flags.httpClientRequestOptionsType }
      : {}),
    ...(flags.httpClientOmitKeys ? { omitKeys: flags.httpClientOmitKeys } : {}),
  };

  return Object.keys(httpClient).length > 0 ? httpClient : undefined;
}

function mergeOptions(configOptions: Partial<Options>, explicitOptions: Partial<Options>): Options {
  return {
    ...configOptions,
    ...explicitOptions,
    httpClient:
      configOptions.httpClient || explicitOptions.httpClient
        ? {
            ...configOptions.httpClient,
            ...explicitOptions.httpClient,
          }
        : undefined,
  } as Options;
}

function printHelp(): void {
  console.log(`Usage: vg [options]

Generate OpenAPI client files once.

Options:
  --input <path-or-url>                    OpenAPI JSON/YAML input
  --output <dir>                           Generated output directory
  --root <dir>                             Project root, defaults to cwd
  --config <file>                          Vite config path, defaults to vite.config.*
  --path-prefix <prefix>                   Path prefix filter
  --strip-prefix <true|false>              Strip path prefix from generated paths
  --no-strip-prefix                        Disable path prefix stripping
  --type-aliases                           Enable top-level generated type aliases
  --no-type-aliases                        Disable top-level generated type aliases
  --http-client-module <module>            Runtime HTTP module import path
  --http-client-json-function <name>       JSON request function name
  --http-client-void-function <name>       Void request function name
  --http-client-request-options-type <name> Request options type name
  --http-client-omit-keys <keys>           Comma-separated keys omitted from request options
  -h, --help                               Show help
`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
