import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: {
        index: "./src/index.ts",
      },
      exports: true,
    },
    {
      entry: {
        cli: "./src/cli.ts",
      },
      exports: {
        bin: {
          vg: "./src/cli.ts",
        },
      },
    },
  ],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ["example/dist/**", "example/src/generated/**"],
  },
  fmt: {
    ignorePatterns: ["example/dist/**", "example/src/generated/**"],
  },
});
