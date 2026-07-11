import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hostExistsInIngress,
  addHostToIngress,
  planStaticHosts,
  applyStaticHosts,
} from "./staticHost.js";

// Protege: la edición del ingress de static-mishi (el único eslabón manual del
// nacimiento de apps). Un parser/editor malo o bien deja la app en 404, o bien
// duplica/corrompe reglas de otras apps ya en producción.

const FIXTURE = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: static-mishi
spec:
  ingressClassName: traefik
  rules:
    - host: bongtella-stage.mishi.com.co
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: static-mishi
                port:
                  number: 80
    - host: bank-stage.mishi.com.co
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: static-mishi
                port:
                  number: 80
`;

test("hostExistsInIngress: detecta un host existente y no confunde substrings", () => {
  assert.equal(hostExistsInIngress(FIXTURE, "bank-stage.mishi.com.co"), true);
  assert.equal(hostExistsInIngress(FIXTURE, "bank.mishi.com.co"), false);
  assert.equal(hostExistsInIngress(FIXTURE, "nueva-app-stage.mishi.com.co"), false);
});

test("addHostToIngress: agrega un bloque clonando la forma de las reglas existentes", () => {
  const out = addHostToIngress(FIXTURE, "nueva-app-stage.mishi.com.co");
  assert.equal(hostExistsInIngress(out, "nueva-app-stage.mishi.com.co"), true);
  // no toca las reglas existentes.
  assert.equal(hostExistsInIngress(out, "bongtella-stage.mishi.com.co"), true);
  assert.equal(hostExistsInIngress(out, "bank-stage.mishi.com.co"), true);
  // el bloque nuevo tiene la forma exacta esperada.
  const bloqueEsperado = [
    "    - host: nueva-app-stage.mishi.com.co",
    "      http:",
    "        paths:",
    "          - path: /",
    "            pathType: Prefix",
    "            backend:",
    "              service:",
    "                name: static-mishi",
    "                port:",
    "                  number: 80",
  ].join("\n");
  assert.ok(out.includes(bloqueEsperado), "el bloque insertado no coincide con la forma esperada");
});

test("addHostToIngress: idempotente — si el host ya existe, devuelve el mismo texto", () => {
  const out = addHostToIngress(FIXTURE, "bank-stage.mishi.com.co");
  assert.equal(out, FIXTURE);
});

test("addHostToIngress: revienta si no encuentra `rules:` (no edita a ciegas)", () => {
  assert.throws(() => addHostToIngress("apiVersion: v1\nkind: Ingress\n", "x.mishi.com.co"), /rules:/);
});

test("planStaticHosts: convención stage con guión, prod sin sufijo", () => {
  assert.deepEqual(planStaticHosts("nueva-app"), {
    stageHost: "nueva-app-stage.mishi.com.co",
    prodHost: "nueva-app.mishi.com.co",
  });
});

test("applyStaticHosts: escribe ambos overlays, idempotente end-to-end (fixtures locales, sin tocar el repo real)", async () => {
  const root = mkdtempSync(join(tmpdir(), "mke-static-host-test-"));
  const stageDir = join(root, "static-mishi", "k8s", "overlays", "stage");
  const prodDir = join(root, "static-mishi", "k8s", "overlays", "prod");
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(prodDir, { recursive: true });
  writeFileSync(join(stageDir, "ingress.yaml"), FIXTURE);
  writeFileSync(join(prodDir, "ingress.yaml"), FIXTURE.replace(/-stage\.mishi\.com\.co/g, ".mishi.com.co"));

  const prevRoot = process.env.MKE_APPS_ROOT;
  process.env.MKE_APPS_ROOT = root;
  try {
    const first = applyStaticHosts("nueva-app");
    assert.equal(first.stageAlready, false);
    assert.equal(first.prodAlready, false);
    assert.equal(first.changed, true);
    assert.equal(first.stageHost, "nueva-app-stage.mishi.com.co");
    assert.equal(first.prodHost, "nueva-app.mishi.com.co");

    const stageText = readFileSync(join(stageDir, "ingress.yaml"), "utf8");
    const prodText = readFileSync(join(prodDir, "ingress.yaml"), "utf8");
    assert.ok(hostExistsInIngress(stageText, "nueva-app-stage.mishi.com.co"));
    assert.ok(hostExistsInIngress(prodText, "nueva-app.mishi.com.co"));

    // segunda corrida: idempotente, "ya existía", no vuelve a escribir.
    const second = applyStaticHosts("nueva-app");
    assert.equal(second.stageAlready, true);
    assert.equal(second.prodAlready, true);
    assert.equal(second.changed, false);
  } finally {
    if (prevRoot === undefined) delete process.env.MKE_APPS_ROOT;
    else process.env.MKE_APPS_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyStaticHosts: revienta con mensaje claro si no encuentra el repo static-mishi", () => {
  const root = mkdtempSync(join(tmpdir(), "mke-static-host-test-missing-"));
  const prevRoot = process.env.MKE_APPS_ROOT;
  process.env.MKE_APPS_ROOT = root;
  try {
    assert.throws(() => applyStaticHosts("nueva-app"), /no encuentro el ingress/);
  } finally {
    if (prevRoot === undefined) delete process.env.MKE_APPS_ROOT;
    else process.env.MKE_APPS_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
