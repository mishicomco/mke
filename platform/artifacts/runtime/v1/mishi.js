// Runtime v1 de artifacts — barra superior estandar + sesion del IdP +
// window.mishi. CONTRATO ESTABLE (ver mishi.css). Los artifacts son PRIVADOS
// por defecto: artifact-guardia ya dejo pasar a quien ve esta pagina; aca solo
// se pregunta QUIEN es (/_mishi/sesion) y se ofrece salir (/_mishi/salir).
// Fase 2: mishi.datos (artifact-mishi); el prototipo usa localStorage.
(() => {
  const artifact = location.hostname.split(".")[0].replace(/-artifact$/, "");

  // mishi.datos (Fase 2, artifact-mishi): documentos por colección×clave en la
  // capa de datos de plataforma. Mismo origen (/api pasa la CSP); el artifact
  // se deduce del Host en el backend — NUNCA se manda como parámetro.
  const api = async (ruta, opts) => {
    const r = await fetch(`/api/datos/${ruta}`, opts);
    if (r.status === 404) return null;
    const cuerpo = await r.json().catch(() => null);
    if (!r.ok) {
      const detalle = cuerpo?.detalle ? `: ${[].concat(cuerpo.detalle).join(", ")}` : "";
      throw new Error(`${cuerpo?.error ?? `HTTP ${r.status}`}${detalle}`);
    }
    return cuerpo;
  };
  const seg = encodeURIComponent;

  // los módulos del artifact corren ANTES de que la sesión llegue: para leer
  // el usuario sin carreras, `const usuario = await mishi.cuandoSesion` —
  // resuelve con el usuario ({sub,email,name}) o null si no hay sesión.
  let resolverSesion;
  const cuandoSesion = new Promise((r) => (resolverSesion = r));

  window.mishi = {
    artifact,
    cuandoSesion,
    sesion: null, // se puebla al resolver /_mishi/sesion; escucha "mishi:sesion"
    datos: {
      guardar: (coleccion, clave, valor) =>
        api(`${seg(coleccion)}/${seg(clave)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ valor }),
        }),
      leer: (coleccion, clave) =>
        api(`${seg(coleccion)}/${seg(clave)}`).then((d) => (d ? d.valor : null)),
      lista: (coleccion) => api(seg(coleccion)).then((d) => d?.documentos ?? []),
      borrar: (coleccion, clave) =>
        api(`${seg(coleccion)}/${seg(clave)}`, { method: "DELETE" }).then((d) => d !== null),
    },
  };

  // Recarga en vivo: la pestaña escucha a la guardia por SSE (cero polling);
  // cuando `mke artifact publicar` termina, empuja "publicacion" y la pagina
  // se recarga sola. EventSource reconecta solo si la guardia se reinicia.
  new EventSource("/_mishi/eventos").addEventListener("publicacion", () =>
    location.reload(),
  );

  // Favicon estandar (Mishi neutro) si el artifact no trae el suyo: mata el
  // 404 de /favicon.ico en todos los artifacts sin republicar ninguno.
  if (!document.querySelector('link[rel~="icon"]')) {
    const icono = document.createElement("link");
    icono.rel = "icon";
    icono.type = "image/svg+xml";
    icono.href = "/runtime/v1/favicon.svg";
    document.head.append(icono);
  }

  // Barra superior estandar. Opt-out: <body data-sin-barra>.
  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.hasAttribute("data-sin-barra")) return;
    const barra = document.createElement("header");
    barra.className = "barra-mishi";
    const nombre = document.createElement("span");
    nombre.className = "barra-nombre";
    nombre.textContent = document.title || artifact;
    const sello = document.createElement("span");
    sello.className = "barra-sello";
    sello.textContent = "artifact";
    sello.title = "Prototipo sin repo propio ni BD. Graduar = mke artifact graduar.";
    // el HUECO de la app dentro de la barra estandar (mismo contrato que
    // BarraMishi del molde): si el body trae un elemento [data-barra], se
    // ADOPTA aca — con sus listeners intactos, la app lo pinta con su piel.
    const hueco = document.createElement("span");
    hueco.className = "barra-hueco";
    const propio = document.querySelector("[data-barra]");
    if (propio) {
      propio.removeAttribute("hidden");
      hueco.append(propio);
    }
    barra.append(nombre, hueco, sello);
    document.body.prepend(barra);

    fetch("/_mishi/sesion")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s || !s.autenticado) {
          resolverSesion(null);
          return;
        }
        window.mishi.sesion = s.usuario;
        resolverSesion(s.usuario);
        const chip = document.createElement("span");
        chip.className = "quien-chip";
        const foto = document.createElement("span");
        foto.className = "quien-foto quien-foto-vacia";
        foto.textContent = (s.usuario.name || s.usuario.email || "?").slice(0, 1);
        const datos = document.createElement("span");
        datos.className = "quien-datos";
        const quien = document.createElement("span");
        quien.className = "quien-nombre";
        quien.textContent = s.usuario.name || s.usuario.email;
        datos.append(quien);
        if (s.usuario.name) {
          const email = document.createElement("span");
          email.className = "quien-email";
          email.textContent = s.usuario.email;
          datos.append(email);
        }
        const salir = document.createElement("button");
        salir.className = "salir-btn";
        salir.textContent = "salir";
        salir.addEventListener("click", () =>
          fetch("/_mishi/salir", { method: "POST" }).then(() => location.reload()),
        );
        chip.append(foto, datos, salir);
        barra.append(chip);
        window.dispatchEvent(new CustomEvent("mishi:sesion", { detail: s.usuario }));
      })
      .catch(() => resolverSesion(null));
  });
})();
