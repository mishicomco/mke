import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { hostsParaEdge, PLATAFORMA } from "./catalogoEdge.js";
import type { EntradaCatalogo } from "./catalogo.js";

const entrada = (parcial: Partial<EntradaCatalogo>): EntradaCatalogo => ({
  app: "x",
  host: "x.mishi.com.co",
  api: false,
  front: false,
  ruta: null,
  ...parcial,
});

describe("hostsParaEdge — la vista prod que consume el worker", () => {
  it("filtra stage: al edge solo van hosts de prod", () => {
    const hosts = hostsParaEdge([
      entrada({ app: "bank", host: "bank-stage.mishi.com.co", api: true, ruta: "/api" }),
      entrada({ app: "bank", host: "bank.mishi.com.co", api: true, ruta: "/api" }),
    ]);
    const bank = hosts.filter((h) => h.nombre === "bank");
    assert.deepEqual(bank, [{ host: "bank.mishi.com.co", nombre: "bank", ruta: "/api" }]);
  });

  it("front puro va sin ruta; status se excluye (no se chequea a sí mismo)", () => {
    const hosts = hostsParaEdge([
      entrada({ app: "mahjong", host: "mahjong.mishi.com.co", front: true }),
      entrada({ app: "status", host: "status.mishi.com.co", api: true, ruta: "/api" }),
    ]);
    assert.ok(hosts.some((h) => h.host === "mahjong.mishi.com.co" && h.ruta === undefined));
    assert.ok(!hosts.some((h) => h.host === "status.mishi.com.co"));
  });

  it("suma la PLATAFORMA sin duplicar un host ya derivado del cluster, fusionando atributos", () => {
    const hosts = hostsParaEdge([
      entrada({ app: "vault", host: "vault.mishi.com.co", api: true, ruta: "/salud" }),
      entrada({ app: "mesh-central", host: "mesh.mishi.com.co", api: true, ruta: "/" }),
    ]);
    assert.equal(hosts.filter((h) => h.host === "vault.mishi.com.co").length, 1);
    const mesh = hosts.find((h) => h.host === "mesh.mishi.com.co");
    assert.equal(mesh?.critico, true, "critico de PLATAFORMA se fusiona en la entrada derivada");
    for (const p of PLATAFORMA.filter((p) => p.host !== "vault.mishi.com.co")) {
      assert.ok(hosts.some((h) => h.host === p.host), `falta ${p.host}`);
    }
  });
});
