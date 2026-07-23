import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { forgeCreateRepo, forgePushMirrorExists, forgeRepoUrl, FORGE } from "./forgeRepo.js";

// Protege el SEAM de red del nacimiento contra el contrato de la API Forgejo:
//   1. IDEMPOTENCIA — re-correr `mke app nacer` sobre un repo existente NO debe
//      volver a POSTear (evita 409 ruidoso / doble creación).
//   2. FORMA del request de creación — POST a /orgs/mishicomco/repos con private
//      + default_branch main: la LEY (repo PRIMARIO en el forge). Un método/path
//      mal armado rompe el nacimiento en silencio.
// Sin red real: monkeypatch de globalThis.fetch.

const fetchReal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchReal;
});

type Call = { url: string; init?: RequestInit };

function mockFetch(handler: (call: Call) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init };
    calls.push(call);
    const { status, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return calls;
}

test("forgeRepoUrl: origin = repo primario en el forge, no GitHub", () => {
  assert.equal(forgeRepoUrl("barrio-mishi"), `${FORGE.base}/${FORGE.org}/barrio-mishi.git`);
});

test("forgeCreateRepo: idempotente — si el repo ya existe (GET 200), NO postea", async () => {
  const calls = mockFetch((c) => (c.init?.method === "POST" ? { status: 201, body: {} } : { status: 200, body: { name: "app" } }));
  const r = await forgeCreateRepo("app", "tok");
  assert.equal(r.creado, false);
  assert.equal(calls.filter((c) => c.init?.method === "POST").length, 0, "no debe haber POST si ya existe");
});

test("forgeCreateRepo: repo nuevo → POST /orgs/<org>/repos privado en main", async () => {
  const calls = mockFetch((c) =>
    c.init?.method === "POST" ? { status: 201, body: { id: 1 } } : { status: 404, body: {} },
  );
  const r = await forgeCreateRepo("nueva-app", "tok");
  assert.equal(r.creado, true);
  const post = calls.find((c) => c.init?.method === "POST");
  assert.ok(post, "debe postear");
  assert.equal(post!.url, `${FORGE.base}/api/v1/orgs/${FORGE.org}/repos`);
  assert.equal((post!.init!.headers as Record<string, string>).Authorization, "token tok");
  assert.deepEqual(JSON.parse(post!.init!.body as string), {
    name: "nueva-app",
    private: true,
    auto_init: false,
    default_branch: "main",
  });
});

test("forgePushMirrorExists: lista no vacía → true (no se reconfigura el mirror)", async () => {
  mockFetch(() => ({ status: 200, body: [{ remoteName: "github" }] }));
  assert.equal(await forgePushMirrorExists("app", "tok"), true);
});
