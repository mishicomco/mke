// Qué protege: la derivación del subdominio/host. El footgun de plataforma es
// que el id interno del app NO es el subdominio público (omni-whatsapp → omni),
// y publicar el front bajo el subPath equivocado da un 404 mudo.

import test from "node:test";
import assert from "node:assert/strict";

import { frontDeHost, hostDeOverlayTexto } from "./appSpec.js";

test("frontDeHost quita el sufijo del entorno", () => {
  assert.equal(frontDeHost("status-stage.mishi.com.co", "stage"), "status");
  assert.equal(frontDeHost("status.mishi.com.co", "prod"), "status");
  assert.equal(frontDeHost("status-local.mishi.com.co", "local"), "status");
});

test("frontDeHost no muerde un nombre que ya termina en algo parecido en prod", () => {
  // en prod el sufijo es vacío: nada se recorta aunque el nombre lleve guiones.
  assert.equal(frontDeHost("mishi-stage.mishi.com.co", "prod"), "mishi-stage");
});

test("hostDeOverlayTexto lee el host del patch del Ingress", () => {
  const yaml = [
    "namespace: stage",
    "patches:",
    "  - target:",
    "      kind: Ingress",
    "    patch: |",
    "      - op: replace",
    "        path: /spec/rules/0/host",
    "        value: status-stage.mishi.com.co",
  ].join("\n");
  assert.equal(hostDeOverlayTexto(yaml), "status-stage.mishi.com.co");
});

test("hostDeOverlayTexto devuelve null si el overlay no parchea el host", () => {
  assert.equal(hostDeOverlayTexto("namespace: stage\nresources:\n  - ../../base\n"), null);
});

test("dirDesdeCI: usa GITHUB_WORKSPACE solo si tiene .mishi-app.json", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { dirDesdeCI } = await import("./appSpec.js");
  const dir = mkdtempSync(join(tmpdir(), "mke-ws-"));
  const prev = process.env.GITHUB_WORKSPACE;
  t.after(() => {
    if (prev === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  delete process.env.GITHUB_WORKSPACE;
  assert.equal(dirDesdeCI(), null);

  process.env.GITHUB_WORKSPACE = dir;
  assert.equal(dirDesdeCI(), null); // sin .mishi-app.json no es un checkout de app

  writeFileSync(join(dir, ".mishi-app.json"), "{}");
  assert.equal(dirDesdeCI(), dir);
});
