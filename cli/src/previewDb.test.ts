import { test } from "node:test";
import assert from "node:assert/strict";
import { dbNamePreview, dbNameStage, parseTablasSensibles, previewDatabaseUrl, sqlTruncarTodo } from "./previewDb.js";

test("dbNamePreview: <app>_<rama_slug>, guiones→underscores", () => {
  assert.equal(dbNamePreview("mishi-bank", "feat-cobros"), "mishi_bank_feat_cobros");
  assert.equal(dbNamePreview("polla-futbolera", "main"), "polla_futbolera_main");
});

test("dbNameStage: snake_case del nombre de la app", () => {
  assert.equal(dbNameStage("mishi-bank"), "mishi_bank");
});

test("previewDatabaseUrl: URL interna al cluster contra databases-dev", () => {
  const url = previewDatabaseUrl("mishi-bank", "feat-cobros", "mishi_bank", "pw");
  assert.equal(url, "postgres://mishi_bank:pw@postgres.databases-dev.svc.cluster.local:5432/mishi_bank_feat_cobros");
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
