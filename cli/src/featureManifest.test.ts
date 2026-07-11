import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeatureManifest, manifiestoVacio } from "./featureManifest.js";

// Protege: el parseo del `mke.feature.yaml` (Contrato 2, CONGELADO). Es la
// única fuente de qué secretos pide el lease del vault y qué config literal
// va al env del pod — un parseo malo filtra secretos de más o de menos.

test("parseFeatureManifest: el ejemplo exacto del Contrato 2", () => {
  const texto = `# mke.feature.yaml — qué necesita el feature-pod de esta app para correr en dev
app: mishi-bank            # id interno (= ns en el vault y en k8s)

secretos:                  # NOMBRES de secretos en el vault (ns = la app, tier dev/stage).
  - MISHI_BANK_SESSION_SECRET     # El feature-pod los recibe por el LEASE (Contrato 1).
  - MISHI_BANK_GOOGLE_CLIENT      # NUNCA su valor acá; solo el nombre.

config:                    # NO secretos: literales/URLs. Van tal cual al env del pod.
  IDENTITY_URL: http://identity-preview.dev.svc:3000
  IDENTITY_JWKS_URL: http://identity-preview.dev.svc:3000/v1/llaves
`;
  const m = parseFeatureManifest(texto);
  assert.equal(m.app, "mishi-bank");
  assert.deepEqual(m.secretos, ["MISHI_BANK_SESSION_SECRET", "MISHI_BANK_GOOGLE_CLIENT"]);
  assert.deepEqual(m.config, {
    IDENTITY_URL: "http://identity-preview.dev.svc:3000",
    IDENTITY_JWKS_URL: "http://identity-preview.dev.svc:3000/v1/llaves",
  });
});

test("parseFeatureManifest: solo 'app' (sin secretos ni config) → listas/mapas vacíos", () => {
  const m = parseFeatureManifest("app: polla\n");
  assert.equal(m.app, "polla");
  assert.deepEqual(m.secretos, []);
  assert.deepEqual(m.config, {});
});

test("parseFeatureManifest: nunca confunde un VALOR de config con un comentario si no hay '#'", () => {
  const m = parseFeatureManifest("app: x\nconfig:\n  URL: http://a.b/c#d\n");
  // '#' corta el resto de la línea aunque venga dentro de una URL: es la
  // limitación documentada del formato chico (sin comillas) — igual que
  // parseDotEnv de dev-receta. Se prueba el comportamiento REAL, no lo ideal.
  assert.equal(m.config.URL, "http://a.b/c");
});

test("parseFeatureManifest: falta 'app' → revienta con mensaje claro", () => {
  assert.throws(() => parseFeatureManifest("secretos:\n  - X\n"), /falta 'app'/);
});

test("parseFeatureManifest: clave de nivel raíz desconocida → revienta", () => {
  assert.throws(() => parseFeatureManifest("app: x\nsecretosss:\n  - X\n"), /clave de nivel raíz desconocida/);
});

test("parseFeatureManifest: item de 'secretos' sin '-' → revienta", () => {
  assert.throws(() => parseFeatureManifest("app: x\nsecretos:\n  MAL\n"), /item de 'secretos' inválido/);
});

test("parseFeatureManifest: entrada de 'config' sin ':' → revienta", () => {
  assert.throws(() => parseFeatureManifest("app: x\nconfig:\n  MAL\n"), /entrada de 'config' inválida/);
});

test("parseFeatureManifest: ignora líneas vacías y comentarios de línea completa", () => {
  const m = parseFeatureManifest("app: x\n\n# comentario suelto\nsecretos:\n  - A\n  # otro comentario\n  - B\n");
  assert.deepEqual(m.secretos, ["A", "B"]);
});

test("manifiestoVacio: archivo ausente ⇒ sin secretos ni config (Contrato 2: no es error)", () => {
  assert.deepEqual(manifiestoVacio("mishi-bank"), { app: "mishi-bank", secretos: [], config: {} });
});
