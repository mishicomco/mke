// Lógica PURA de la fase MATERIALIZAR (Secret k8s derivado del vault).
// Lo que protege: el mapeo nombre__env→clave (si se equivoca, una app de stage
// recibe secretos de prod), el merge (si se equivoca, se BORRAN claves vivas del
// cluster — la cicatriz del 2026-07-28) y la compuerta de declaración.
// Ningún test toca red ni cluster: todo es determinista.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  claveDeNombre,
  clavesDelEntorno,
  compararDeclaracion,
  nombreDatabaseUrl,
  planMaterializacion,
  sufijoEnv,
} from "./secretosDelVault.js";

describe("sufijoEnv", () => {
  it("stage y prod viven en el vault; local no", () => {
    assert.equal(sufijoEnv("stage"), "stage");
    assert.equal(sufijoEnv("prod"), "prod");
    assert.equal(sufijoEnv("local"), null);
    assert.equal(sufijoEnv("cualquiera"), null);
  });
});

describe("claveDeNombre", () => {
  it("quita el sufijo del entorno", () => {
    assert.equal(claveDeNombre("SESSION_SECRET__stage", "stage"), "SESSION_SECRET");
    assert.equal(claveDeNombre("DATABASE_URL__prod", "prod"), "DATABASE_URL");
  });

  it("NO cruza entornos (la cicatriz que este mapeo evita)", () => {
    assert.equal(claveDeNombre("SESSION_SECRET__prod", "stage"), null);
    assert.equal(claveDeNombre("SESSION_SECRET__stage", "prod"), null);
  });

  it("ignora nombres sin sufijo y entornos fuera del vault", () => {
    assert.equal(claveDeNombre("SESSION_SECRET", "stage"), null);
    assert.equal(claveDeNombre("SESSION_SECRET__stage", "local"), null);
  });

  it("no acepta clave vacía", () => {
    assert.equal(claveDeNombre("__stage", "stage"), null);
  });

  it("respeta claves que contienen dobles guiones bajos internos", () => {
    assert.equal(claveDeNombre("A__B__stage", "stage"), "A__B");
  });
});

describe("clavesDelEntorno", () => {
  it("filtra por entorno y ordena por clave", () => {
    const r = clavesDelEntorno(
      ["Z__stage", "A__stage", "B__prod", "SIN_SUFIJO"],
      "stage",
    );
    assert.deepEqual(r, [
      { clave: "A", nombre: "A__stage" },
      { clave: "Z", nombre: "Z__stage" },
    ]);
  });
});

describe("planMaterializacion", () => {
  const delVault = [
    { clave: "DATABASE_URL", nombre: "DATABASE_URL__stage" },
    { clave: "SESSION_SECRET", nombre: "SESSION_SECRET__stage" },
  ];

  it("el vault MANDA: una clave presente en ambos lados se re-materializa", () => {
    const plan = planMaterializacion(delVault, ["DATABASE_URL", "SESSION_SECRET"]);
    assert.deepEqual(plan.aMaterializar.map((c) => c.clave), ["DATABASE_URL", "SESSION_SECRET"]);
    assert.deepEqual(plan.huerfanas, []);
  });

  it("una clave del cluster que el vault NO conoce se CONSERVA y se reporta", () => {
    const plan = planMaterializacion(delVault, ["SESSION_SECRET", "SESSION_ES256_KEY", "ALLOWED_EMAILS"]);
    assert.deepEqual(plan.huerfanas, ["ALLOWED_EMAILS", "SESSION_ES256_KEY"]);
    // jamás aparece en aMaterializar (nada de borrarla ni pisarla con vacío)
    assert.equal(plan.aMaterializar.some((c) => c.clave === "SESSION_ES256_KEY"), false);
  });

  it("Secret inexistente en el cluster: nada huérfano, todo se materializa", () => {
    const plan = planMaterializacion(delVault, []);
    assert.equal(plan.aMaterializar.length, 2);
    assert.deepEqual(plan.huerfanas, []);
  });

  it("vault vacío: no se materializa nada y TODO el cluster queda huérfano (no se borra)", () => {
    const plan = planMaterializacion([], ["A", "B"]);
    assert.deepEqual(plan.aMaterializar, []);
    assert.deepEqual(plan.huerfanas, ["A", "B"]);
  });
});

describe("compararDeclaracion", () => {
  it("declarado y ausente del vault → faltante (FAIL del preflight)", () => {
    const r = compararDeclaracion(["A", "B"], ["A"]);
    assert.deepEqual(r.faltantes, ["B"]);
    assert.deepEqual(r.noDeclarados, []);
  });

  it("en el vault y no declarado → solo WARN de transición", () => {
    const r = compararDeclaracion(["A"], ["A", "C"]);
    assert.deepEqual(r.faltantes, []);
    assert.deepEqual(r.noDeclarados, ["C"]);
  });

  it("declaración vacía: nada falta, todo el vault queda como no declarado", () => {
    const r = compararDeclaracion([], ["A", "B"]);
    assert.deepEqual(r.faltantes, []);
    assert.deepEqual(r.noDeclarados, ["A", "B"]);
  });

  it("coincidencia exacta: compuerta limpia", () => {
    const r = compararDeclaracion(["B", "A"], ["A", "B"]);
    assert.deepEqual(r.faltantes, []);
    assert.deepEqual(r.noDeclarados, []);
  });
});

describe("nombreDatabaseUrl", () => {
  it("lleva el sufijo del entorno", () => {
    assert.equal(nombreDatabaseUrl("stage"), "DATABASE_URL__stage");
    assert.equal(nombreDatabaseUrl("prod"), "DATABASE_URL__prod");
  });

  it("revienta en entornos que no viven en el vault", () => {
    assert.throws(() => nombreDatabaseUrl("local"), /no vive en el vault/);
  });
});
