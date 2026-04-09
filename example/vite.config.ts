import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

import { openapiCodegen } from "../src/index.ts";

const exampleRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    openapiCodegen({
      input: "openapi.json",
      output: "src/generated",
      httpClient: {
        module: "@example/http",
        jsonFunction: "fetchJson",
        voidFunction: "fetchVoid",
        requestOptionsType: "RequestOptions",
        omitKeys: ["json", "method", "signal"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@example/http": resolve(exampleRoot, "src/http.ts"),
    },
  },
});
