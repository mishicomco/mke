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
