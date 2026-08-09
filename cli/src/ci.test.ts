// Qué protege: la lectura del CI del forge. El incidente real fue un
// `workflow_dispatch` con input desconocido que cayó en silencio a stage con run
// VERDE — de ahí que `runFallido` y la validación de environment sean explícitas.

import test from "node:test";
import assert from "node:assert/strict";

import { ENVS_CI, EXIT_WAIT, elegirRun, esSha, lineasDeError, parsearRuns, runFallido, runTerminal, validarDispatch } from "./ci.js";
import type { RunCi } from "./ci.js";

// fábrica para los tests de elegirRun (el corazón anti-falso-positivo del wait).
function run(p: Partial<RunCi>): RunCi {
  return { id: 1, indice: 1, estado: "success", conclusion: "success", rama: "main", sha: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111", evento: "push", creado: "", titulo: "", ...p };
}

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
  const base = { id: 1, indice: 1, estado: "done", rama: "main", sha: "", evento: "push", creado: "", titulo: "" };
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

// ── ci wait: elegir EL run, nunca "el último" ────────────────────────────────

test("elegirRun por tag: matchea prettyref exacto y elige el más nuevo, no runs de main", () => {
  const runs = [
    run({ id: 10, rama: "main", estado: "success" }),
    run({ id: 12, rama: "v0.1.2", estado: "running", conclusion: "" }),
    run({ id: 11, rama: "main", estado: "success" }),
  ];
  assert.equal(elegirRun(runs, "v0.1.2")?.id, 12);
  assert.equal(elegirRun(runs, "v9.9.9"), null);
});

test("elegirRun con minId ignora runs pre-existentes (la raíz del falso positivo)", () => {
  // escenario real: push a main, el run nuevo AÚN no existe; el viejo es success.
  const antes = [run({ id: 10, rama: "main", estado: "success" })];
  assert.equal(elegirRun(antes, "main", { minId: 10 }), null); // NO reporta el viejo
  const despues = [...antes, run({ id: 13, rama: "main", estado: "running", conclusion: "" })];
  assert.equal(elegirRun(despues, "main", { minId: 10 })?.id, 13);
});

test("elegirRun por sha y con --sha desambigua tag+main simultáneos del mismo push", () => {
  const runs = [
    run({ id: 20, rama: "main", sha: "3c82f9ac".padEnd(40, "0") }),
    run({ id: 21, rama: "v0.1.2", sha: "3c82f9ac".padEnd(40, "0") }),
    run({ id: 19, rama: "main", sha: "deadbeef".padEnd(40, "0") }),
  ];
  assert.equal(elegirRun(runs, "3c82f9ac")?.id, 21); // por sha: el más nuevo de ese sha
  assert.equal(elegirRun(runs, "v0.1.2")?.id, 21); // por tag: sigue el tag, no main
  assert.equal(elegirRun(runs, "main", { sha: "3c82f9ac" })?.id, 20); // rama + sha exacto
  assert.equal(elegirRun(runs, "main", { sha: "cafecafe" }), null);
});

test("elegirRun ignora eventos delete (on:delete de previews comparte prettyref)", () => {
  const runs = [run({ id: 30, rama: "main", evento: "delete" })];
  assert.equal(elegirRun(runs, "main"), null);
});

test("esSha reconoce hex ≥7 y no confunde tags ni ramas", () => {
  assert.equal(esSha("3c82f9ac"), true);
  assert.equal(esSha("main"), false);
  assert.equal(esSha("v0.1.2"), false);
  assert.equal(esSha("abc"), false);
});

test("runTerminal: running/waiting NO son terminales; success/failure/skipped sí", () => {
  assert.equal(runTerminal(run({ estado: "running", conclusion: "" })), false);
  assert.equal(runTerminal(run({ estado: "waiting", conclusion: "" })), false);
  assert.equal(runTerminal(run({ estado: "success" })), true);
  assert.equal(runTerminal(run({ estado: "failure", conclusion: "failure" })), true);
  assert.equal(runTerminal(run({ estado: "skipped", conclusion: "skipped" })), true);
});

test("los exit codes del wait son inequívocos y solo success es 0", () => {
  assert.equal(EXIT_WAIT.success, 0);
  const noVerdes = [EXIT_WAIT.fallo, EXIT_WAIT.timeout, EXIT_WAIT["no-aparecio"], EXIT_WAIT.killed];
  assert.ok(noVerdes.every((c) => c > 0));
  assert.equal(new Set(noVerdes).size, 4); // distinguibles entre sí
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
