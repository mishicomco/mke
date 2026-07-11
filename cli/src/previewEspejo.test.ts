import { test } from "node:test";
import assert from "node:assert/strict";
import { dbNameStage, parseTablasSensibles, sqlTruncarTodo } from "./previewEspejo.js";

test("dbNameStage: snake_case del nombre de la app", () => {
  assert.equal(dbNameStage("mishi-bank"), "mishi_bank");
  assert.equal(dbNameStage("polla-futbolera"), "polla_futbolera");
});

test("parseTablasSensibles: una tabla por línea, ignora vacías y comentarios", () => {
  const txt = [
    "# tablas con datos sensibles",
    "secreto_valor",
    "",
    "  auditoria  ",
    "# nota: PII/estrategia de Santi",
    "nota",
  ].join("\n");
  assert.deepEqual(parseTablasSensibles(txt), ["secreto_valor", "auditoria", "nota"]);
  assert.deepEqual(parseTablasSensibles(""), []);
  assert.deepEqual(parseTablasSensibles("# solo comentarios\n\n"), []);
});

test("sqlTruncarTodo: genera el SELECT que arma el TRUNCATE dinámico (patrón iterar-rama.sh)", () => {
  const sql = sqlTruncarTodo();
  assert.match(sql, /truncate table/);
  assert.match(sql, /information_schema\.tables/);
  assert.match(sql, /table_schema='public'/);
});
