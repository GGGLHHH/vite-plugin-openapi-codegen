const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main>
    <h1>vite-plugin-openapi-codegen example</h1>
    <p>
      This example demonstrates automatic code generation from
      <code>openapi.json</code> via <code>example/vite.config.ts</code>.
    </p>
    <p>
      Run <code>vp build example --config example/vite.config.ts</code> to regenerate
      files in <code>src/generated</code>.
    </p>
  </main>
`.trim();
