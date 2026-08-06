import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aplicarNodo, type EnvSpec } from "./mkeConfig.js";

function envsBase(): Record<string, EnvSpec> {
  return {
    prod: {
      context: "mke-prod-laptop",
      cluster: "mke-prod",
      namespace: "prod",
      tunnelUuid: "x",
      hostSuffix: "",
      hostGatewayIp: "172.18.0.1",
      remote: { ssh: "mishi@10.0.0.4", sshKey: "~/.ssh/k", nodo: "k3d-mke-prod-server-0" },
    },
    stage: {
      context: "k3d-mke-prod",
      cluster: "mke-prod",
      namespace: "stage",
      tunnelUuid: "y",
      hostSuffix: "-stage",
      hostGatewayIp: "172.20.0.1",
    },
  };
}

function conNodoFile(contenido: string | null, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "mke-nodo-"));
  const file = join(dir, "mke-nodo.json");
  if (contenido !== null) writeFileSync(file, contenido);
  const prev = process.env.MKE_NODO_FILE;
  process.env.MKE_NODO_FILE = file;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.MKE_NODO_FILE;
    else process.env.MKE_NODO_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sin mke-nodo.json los ENVS quedan intactos (pc gamer)", () => {
  conNodoFile(null, () => {
    const envs = aplicarNodo(envsBase());
    assert.equal(envs.prod.context, "mke-prod-laptop");
    assert.ok(envs.prod.remote);
  });
});

test("envsLocales:[prod] vuelve prod local: contexto k3d y sin remote (laptop)", () => {
  conNodoFile('{ "envsLocales": ["prod"] }', () => {
    const envs = aplicarNodo(envsBase());
    assert.equal(envs.prod.context, "k3d-mke-prod");
    assert.equal(envs.prod.remote, undefined);
    // los demás envs no se tocan
    assert.equal(envs.stage.context, "k3d-mke-prod");
  });
});

test("un env ya local en envsLocales es un no-op", () => {
  conNodoFile('{ "envsLocales": ["stage"] }', () => {
    const envs = aplicarNodo(envsBase());
    assert.equal(envs.stage.context, "k3d-mke-prod");
    assert.equal(envs.stage.remote, undefined);
  });
});

test("env desconocido en envsLocales revienta con mensaje claro", () => {
  conNodoFile('{ "envsLocales": ["produ"] }', () => {
    assert.throws(() => aplicarNodo(envsBase()), /env desconocido: produ/);
  });
});

test("json ilegible revienta en vez de seguir con config a medias", () => {
  conNodoFile("{ envsLocales: [", () => {
    assert.throws(() => aplicarNodo(envsBase()), /ilegible/);
  });
});
