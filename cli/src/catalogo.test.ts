// Qué protege: el catálogo es un CONTRATO con status-mishi (lo consume como
// verdad de qué existe en el ecosistema). Lo que se testea es la derivación:
// que un host con backend gane `api: true` sobre el mismo host servido por
// static-mishi, y que los ingress ajenos a MKE no se cuelen.

import test from "node:test";
import assert from "node:assert/strict";

import { derivarCatalogo, parsearIngresses, rutaDeSalud, type IngressLite } from "./catalogo.js";

const mke = (name: string, host: string, paths: string[] = ["/api"]): IngressLite => ({
  name,
  labels: { "app.kubernetes.io/part-of": "mke", "app.kubernetes.io/name": name },
  hosts: [host],
  paths,
});

const estatico = (hosts: string[]): IngressLite => ({
  name: "static-mishi",
  labels: {},
  hosts,
  paths: ["/"],
});

test("un host con backend queda api:true; un front puro queda api:false", () => {
  const c = derivarCatalogo([mke("status-mishi", "status-stage.mishi.com.co"), estatico(["bongtella-stage.mishi.com.co"])], "stage");
  assert.deepEqual(
    c.map((e) => [e.app, e.api, e.front]),
    [
      ["bongtella", false, true],
      ["status-mishi", true, false],
    ],
  );
});

test("host servido por static Y con backend: gana api:true y conserva front:true", () => {
  const host = "status-stage.mishi.com.co";
  const c = derivarCatalogo([estatico([host]), mke("status-mishi", host)], "stage");
  assert.equal(c.length, 1);
  assert.equal(c[0].api, true);
  assert.equal(c[0].front, true);
  assert.equal(c[0].app, "status-mishi");
});

test("ingress sin la etiqueta part-of=mke no entra al catálogo", () => {
  const ajeno: IngressLite = { name: "ajeno", labels: {}, hosts: ["x.mishi.com.co"], paths: ["/"] };
  assert.deepEqual(derivarCatalogo([ajeno], "stage"), []);
});

test("la ruta de salud prefiere /salud sobre los demás paths", () => {
  assert.equal(rutaDeSalud(["/api", "/v1", "/salud"]), "/salud");
  assert.equal(rutaDeSalud(["/api"]), "/api");
  assert.equal(rutaDeSalud([]), null);
});

test("parsearIngresses tolera JSON basura y aplana hosts+paths", () => {
  assert.deepEqual(parsearIngresses("no-json"), []);
  const json = JSON.stringify({
    items: [
      {
        metadata: { name: "a", labels: { "app.kubernetes.io/part-of": "mke" } },
        spec: { rules: [{ host: "a.mishi.com.co", http: { paths: [{ path: "/salud" }] } }] },
      },
    ],
  });
  assert.deepEqual(parsearIngresses(json), [
    { name: "a", labels: { "app.kubernetes.io/part-of": "mke" }, hosts: ["a.mishi.com.co"], paths: ["/salud"] },
  ]);
});

test("entradaDeEnv separa por sufijo del host (contrato status-mishi)", async () => {
  const { entradaDeEnv } = await import("./catalogo.js");
  const stage = { app: "bank", host: "bank-stage.mishi.com.co", api: true, front: true, ruta: null };
  const prod = { app: "bank", host: "bank.mishi.com.co", api: true, front: true, ruta: null };
  assert.equal(entradaDeEnv(stage, "stage"), true);
  assert.equal(entradaDeEnv(stage, "prod"), false);
  assert.equal(entradaDeEnv(prod, "prod"), true);
  assert.equal(entradaDeEnv(prod, "stage"), false);
});
