// Runtime v1 de artifacts — barra superior estandar + sesion del IdP +
// window.mishi. CONTRATO ESTABLE (ver mishi.css). Los artifacts son PRIVADOS
// por defecto: artifact-guardia ya dejo pasar a quien ve esta pagina; aca solo
// se pregunta QUIEN es (/_mishi/sesion) y se ofrece salir (/_mishi/salir).
// mishi.datos (artifact-mishi) es la capa de datos VIVA en prod; localStorage
// solo para juguetes.
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

  // ── Panel de identidad + modo "probar como rol" ──────────────────────────
  // Click en el chip de sesion → panel con roles y permisos (GET /api/iam/yo,
  // lo sirve artifact-mishi consultando iam-mishi). Si el usuario REAL es
  // admin, el panel ofrece "probar como rol": setea la cookie mishi_como_rol
  // (scope = este host) y recarga — el backend evalua la autorizacion como si
  // portara SOLO ese rol (jamas eleva; sin admin real la cookie es letra
  // muerta). Banda visible mientras la simulacion esta activa.
  const COOKIE_ROL = "mishi_como_rol";
  const probarComo = (rol) => {
    document.cookie = rol
      ? `${COOKIE_ROL}=${encodeURIComponent(rol)}; path=/; max-age=28800; samesite=lax`
      : `${COOKIE_ROL}=; path=/; max-age=0`;
    location.reload();
  };
  window.mishi.iam = {
    yo: () => fetch("/api/iam/yo").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    probarComo,
    volver: () => probarComo(null),
  };

  const instalarPanelIam = (barra, chip, usuario) => {
    chip.classList.add("quien-chip-click");
    chip.title = "Mis roles y permisos";
    let panel = null;
    const cerrar = () => {
      if (panel) panel.remove();
      panel = null;
    };
    document.addEventListener("click", (ev) => {
      if (panel && !panel.contains(ev.target) && !chip.contains(ev.target)) cerrar();
    });
    chip.addEventListener("click", async (ev) => {
      if (ev.target.closest(".salir-btn")) return; // salir sigue siendo salir
      if (panel) return cerrar();
      panel = document.createElement("div");
      panel.className = "iam-panel";
      panel.textContent = "cargando…";
      barra.append(panel);
      const yo = await window.mishi.iam.yo();
      if (!panel) return;
      panel.textContent = "";
      const seccion = (titulo) => {
        const t = document.createElement("div");
        t.className = "iam-titulo";
        t.textContent = titulo;
        panel.append(t);
        return t;
      };
      const quien = document.createElement("div");
      quien.className = "iam-quien";
      quien.textContent = usuario.name ? `${usuario.name} — ${usuario.email}` : usuario.email;
      panel.append(quien);
      if (!yo || yo.authenticated !== true) {
        const aviso = document.createElement("div");
        aviso.className = "iam-vacio";
        aviso.textContent = "roles y permisos no disponibles en este artifact";
        panel.append(aviso);
        return;
      }
      seccion(yo.simulando ? `roles (simulando: ${yo.simulando})` : "mis roles");
      const roles = document.createElement("div");
      roles.className = "iam-roles";
      if (yo.efectivos && yo.efectivos.roles.length) {
        for (const r of yo.efectivos.roles) {
          const el = document.createElement("span");
          el.className = "iam-rol";
          el.textContent = `${r.app}/${r.nombre}`;
          el.title = (r.descripcion || "") + (r.ambito === "ecosistema" ? " · ámbito: todo el ecosistema" : "");
          roles.append(el);
        }
      } else {
        roles.textContent = yo.efectivos ? "sin roles en esta app" : "iam no disponible";
        roles.className = "iam-vacio";
      }
      panel.append(roles);
      seccion("permisos");
      const lista = document.createElement("ul");
      lista.className = "iam-permisos";
      for (const p of yo.efectivos?.permisos ?? []) {
        const li = document.createElement("li");
        li.className = p.concedido ? "iam-si" : "iam-no";
        li.textContent = p.nombre;
        if (p.descripcion) li.title = p.descripcion;
        lista.append(li);
      }
      if (!lista.children.length) {
        lista.remove();
        const vacio = document.createElement("div");
        vacio.className = "iam-vacio";
        vacio.textContent = yo.efectivos ? "esta app no declara permisos" : "iam no disponible";
        panel.append(vacio);
      } else panel.append(lista);
      if (yo.esAdmin && yo.rolesDisponibles.length) {
        seccion("probar como");
        const sel = document.createElement("select");
        sel.className = "iam-probar";
        const base = document.createElement("option");
        base.value = "";
        base.textContent = "yo (sin simular)";
        sel.append(base);
        for (const r of yo.rolesDisponibles) {
          const op = document.createElement("option");
          op.value = r.nombre;
          op.textContent = r.descripcion ? `${r.nombre} — ${r.descripcion}` : r.nombre;
          if (yo.simulando === r.nombre) op.selected = true;
          sel.append(op);
        }
        sel.addEventListener("change", () => probarComo(sel.value || null));
        panel.append(sel);
      }
    });
    // banda persistente mientras se simula (aunque el panel este cerrado)
    window.mishi.iam.yo().then((yo) => {
      if (!yo || yo.authenticated !== true || !yo.simulando) return;
      const banda = document.createElement("div");
      banda.className = "iam-banda";
      const texto = document.createElement("span");
      texto.textContent = `viendo como rol: ${yo.simulando}`;
      const volver = document.createElement("button");
      volver.className = "iam-volver";
      volver.textContent = "volver a mí";
      volver.addEventListener("click", () => probarComo(null));
      banda.append(texto, volver);
      barra.after(banda);
    });
  };

  // Barra superior estandar. Opt-out: <body data-sin-barra> (solo quita la
  // barra: la sesion SIEMPRE se resuelve — sin esto, cuandoSesion quedaba
  // colgado para siempre en artifacts sin barra).
  document.addEventListener("DOMContentLoaded", () => {
    const sinBarra = document.body.hasAttribute("data-sin-barra");
    if (sinBarra) {
      fetch("/_mishi/sesion")
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          const usuario = s && s.autenticado ? s.usuario : null;
          window.mishi.sesion = usuario;
          resolverSesion(usuario);
          if (usuario) window.dispatchEvent(new CustomEvent("mishi:sesion", { detail: usuario }));
        })
        .catch(() => resolverSesion(null));
      return;
    }
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
        instalarPanelIam(barra, chip, s.usuario);
        window.dispatchEvent(new CustomEvent("mishi:sesion", { detail: s.usuario }));
      })
      .catch(() => resolverSesion(null));
  });
})();
