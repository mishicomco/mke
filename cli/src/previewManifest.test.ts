import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePreviewManifest, manifiestoVacio } from "./previewManifest.js";

// Protege: el parseo del `mke.preview.yaml` (Contrato 2). Es la única fuente de
// qué secretos pide el lease del vault y qué config literal va al env del pod —
// un parseo malo filtra secretos de más o de menos.

test("parsePreviewManifest: el ejemplo exacto del Contrato 2", () => {
  const texto = `# mke.preview.yaml — qué necesita el preview-pod de esta app para correr
app: mishi-bank            # id interno (= ns en el vault y en k8s)

secretos:                  # NOMBRES de secretos en el vault (ns = la app, tier dev/stage).
  - MISHI_BANK_SESSION_SECRET     # El preview-pod los recibe por el LEASE (Contrato 1).
  - MISHI_BANK_GOOGLE_CLIENT      # NUNCA su valor acá; solo el nombre.

config:                    # NO secretos: literales/URLs. Van tal cual al env del pod.
  IDENTITY_URL: http://identity-preview.dev.svc:3000
  IDENTITY_JWKS_URL: http://identity-preview.dev.svc:3000/v1/llaves
`;
  const m = parsePreviewManifest(texto);
  assert.equal(m.app, "mishi-bank");
  assert.deepEqual(m.secretos, ["MISHI_BANK_SESSION_SECRET", "MISHI_BANK_GOOGLE_CLIENT"]);
  assert.deepEqual(m.config, {
    IDENTITY_URL: "http://identity-preview.dev.svc:3000",
    IDENTITY_JWKS_URL: "http://identity-preview.dev.svc:3000/v1/llaves",
  });
});

test("parsePreviewManifest: solo 'app' (sin secretos ni config) → listas/mapas vacíos", () => {
  const m = parsePreviewManifest("app: polla\n");
  assert.equal(m.app, "polla");
  assert.deepEqual(m.secretos, []);
  assert.deepEqual(m.config, {});
});

test("parsePreviewManifest: nunca confunde un VALOR de config con un comentario si no hay '#'", () => {
  const m = parsePreviewManifest("app: x\nconfig:\n  URL: http://a.b/c#d\n");
  // '#' corta el resto de la línea aunque venga dentro de una URL: es la
  // limitación documentada del formato chico (sin comillas). Se prueba el
  // comportamiento REAL, no lo ideal.
  assert.equal(m.config.URL, "http://a.b/c");
});

test("parsePreviewManifest: 'app' opcional (la pone el caller) y sanity check si difiere", () => {
  assert.deepEqual(parsePreviewManifest("secretos:\n  - X\n", "mi-app"), { app: "mi-app", secretos: ["X"], config: {} });
  assert.throws(() => parsePreviewManifest("app: otra\n", "mi-app"), /no coincide/);
});

test("parsePreviewManifest: clave de nivel raíz desconocida → revienta", () => {
  assert.throws(() => parsePreviewManifest("app: x\nsecretosss:\n  - X\n"), /clave de nivel raíz desconocida/);
});

test("parsePreviewManifest: item de 'secretos' sin '-' → revienta", () => {
  assert.throws(() => parsePreviewManifest("app: x\nsecretos:\n  MAL\n"), /item de 'secretos' inválido/);
});

test("parsePreviewManifest: entrada de 'config' sin ':' → revienta", () => {
  assert.throws(() => parsePreviewManifest("app: x\nconfig:\n  MAL\n"), /entrada de 'config' inválida/);
});

test("parsePreviewManifest: ignora líneas vacías y comentarios de línea completa", () => {
  const m = parsePreviewManifest("app: x\n\n# comentario suelto\nsecretos:\n  - A\n  # otro comentario\n  - B\n");
  assert.deepEqual(m.secretos, ["A", "B"]);
});

test("manifiestoVacio: archivo ausente ⇒ sin secretos ni config (Contrato 2: no es error)", () => {
  assert.deepEqual(manifiestoVacio("mishi-bank"), { app: "mishi-bank", secretos: [], config: {} });
});
