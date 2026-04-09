import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    exports: true,
  },
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
