const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main>
    <h1>Online link demo</h1>
    <p>
      This example points at <code>http://localhost:8080/openapi.yaml</code>.
    </p>
  </main>
`.trim();
