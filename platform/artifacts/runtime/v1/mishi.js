// Runtime v1 de artifacts — barra superior estandar + sesion del IdP +
// window.mishi. CONTRATO ESTABLE (ver mishi.css). Los artifacts son PRIVADOS
// por defecto: artifact-guardia ya dejo pasar a quien ve esta pagina; aca solo
// se pregunta QUIEN es (/_mishi/sesion) y se ofrece salir (/_mishi/salir).
// Fase 2: mishi.datos (artifact-mishi); el prototipo usa localStorage.
(() => {
  const artifact = location.hostname.split(".")[0].replace(/-artifact$/, "");

  const sinDatos = () => {
    throw new Error(
      "mishi.datos llega en Fase 2 (artifact-mishi). Por ahora usa localStorage.",
    );
  };

  window.mishi = {
    artifact,
    sesion: null, // se puebla al resolver /_mishi/sesion; escucha "mishi:sesion"
    datos: { guardar: sinDatos, leer: sinDatos, lista: sinDatos, borrar: sinDatos },
  };

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
    barra.append(nombre, sello);
    document.body.prepend(barra);

    fetch("/_mishi/sesion")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s || !s.autenticado) return;
        window.mishi.sesion = s.usuario;
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
      .catch(() => {});
  });
})();
