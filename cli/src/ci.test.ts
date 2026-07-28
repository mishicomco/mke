// Qué protege: la lectura del CI del forge. El incidente real fue un
// `workflow_dispatch` con input desconocido que cayó en silencio a stage con run
// VERDE — de ahí que `runFallido` y la validación de environment sean explícitas.

import test from "node:test";
import assert from "node:assert/strict";

import { ENVS_CI, lineasDeError, parsearRuns, runFallido, validarDispatch } from "./ci.js";

test("parsearRuns acepta {workflow_runs:[…]} y también un array pelado", () => {
  const uno = parsearRuns(JSON.stringify({ workflow_runs: [{ id: 7, status: "done", conclusion: "success", head_branch: "main" }] }));
  assert.equal(uno.length, 1);
  assert.equal(uno[0].id, 7);
  assert.equal(uno[0].rama, "main");
  assert.equal(parsearRuns(JSON.stringify([{ id: 9 }]))[0].id, 9);
  assert.deepEqual(parsearRuns("no-json"), []);
});

test("forma REAL de Forgejo: veredicto en `status`, rama en `prettyref`", () => {
  const [r] = parsearRuns(
    JSON.stringify([
      { id: 118, index_in_repo: 11, status: "failure", prettyref: "main", trigger_event: "push", created: "2026-07-27T00:00:00Z", title: "x" },
    ]),
  );
  assert.equal(r.id, 118);
  assert.equal(r.indice, 11);
  assert.equal(r.conclusion, "failure");
  assert.equal(r.rama, "main");
  assert.equal(runFallido(r), true);
});

test("un run todavía corriendo no cuenta como fallido", () => {
  const [r] = parsearRuns(JSON.stringify([{ id: 1, status: "running" }]));
  assert.equal(r.conclusion, "");
  assert.equal(runFallido(r), false);
});

test("runFallido reconoce failure/cancelled y no marca success", () => {
  const base = { id: 1, indice: 1, estado: "done", rama: "main", evento: "push", creado: "", titulo: "" };
  assert.equal(runFallido({ ...base, conclusion: "failure" }), true);
  assert.equal(runFallido({ ...base, conclusion: "cancelled" }), true);
  assert.equal(runFallido({ ...base, conclusion: "success" }), false);
  assert.equal(runFallido({ ...base, conclusion: "" }), false);
});

test("lineasDeError filtra las líneas sospechosas y cae al log entero si no hay", () => {
  const log = "paso 1 ok\n::error::migracion fallida\npaso 2 ok\n";
  assert.deepEqual(lineasDeError(log), ["::error::migracion fallida"]);
  assert.deepEqual(lineasDeError("todo bien\nsigue bien\n"), ["todo bien", "sigue bien"]);
});

test("los únicos environments válidos del dispatch son stage y prod", () => {
  assert.deepEqual([...ENVS_CI], ["stage", "prod"]);
  assert.ok("error" in validarDispatch("produccion"));
});

test("stage: ref default main, y se puede pasar cualquier rama", () => {
  assert.deepEqual(validarDispatch("stage"), { ref: "main" });
  assert.deepEqual(validarDispatch("stage", "feature-x"), { ref: "feature-x" });
});

test("prod EXIGE --ref explícito y que sea un tag v*", () => {
  // sin --ref: no se despliega prod por accidente desde main.
  const sinRef = validarDispatch("prod");
  assert.ok("error" in sinRef && /--ref EXPLÍCITO/.test(sinRef.error));
  // con una rama en vez de un tag: también se rechaza.
  const conRama = validarDispatch("prod", "main");
  assert.ok("error" in conRama && /tag `v\*`/.test(conRama.error));
  // con el tag correcto: pasa.
  assert.deepEqual(validarDispatch("prod", "v0.1.2"), { ref: "v0.1.2" });
});
