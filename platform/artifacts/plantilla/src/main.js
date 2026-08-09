// Modulos ES nativos: importa libre entre archivos de ./src (la CSP permite
// script-src 'self'). Persistencia: usa mishi.datos.* (backend de plataforma,
// guardar/lista/leer/borrar) declarando colecciones en el <script
// application/mishi-esquema> del index.html — NO localStorage (juguetes).
// window.mishi trae { artifact, sesion, datos } y el evento "mishi:sesion".

const app = document.getElementById("app");
app.textContent = `hola desde ${window.mishi?.artifact ?? "el artifact"}`;
