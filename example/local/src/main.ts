const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main>
    <h1>Local file demo</h1>
    <p>
      This example points at the shared <code>example/openapi.json</code> file.
    </p>
  </main>
`.trim();
