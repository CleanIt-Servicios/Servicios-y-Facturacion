// ============================================================
// CLEAN IT v2 — Estructura fragmentada
// Andamiaje base. Sin funciones de negocio todavía.
//
// MODELO DE DATOS (refleja las 8 hojas):
//   servicios      hoja 1 → S001: nombre, tipo, cuit, mail, razonSocial, estado, fechaBaja, motivoBaja
//   facturacion    hoja 2 → S001: valorHora, tipoFactura, tipoContrato, montoFijo
//   operarios      hoja 3 → O001: nombreCompleto, jornada, estado
//   supervisores   hoja 4 → P001: nombreCompleto, cargo, estado
//   distribucion   hoja 5 → S001: [turnos → cada turno con id, frecuencia, dias, entrada, salida]
//   movimientos    hoja 8 → M0001: svcId, turnoId, fecha/rango, tipo, quien(P), timestamp
//   (planilla hoja 6 y prefacturación hoja 7 se calculan en memoria)
// ============================================================

const APP = {
  screen: "servicios",
  mes: { y: new Date().getFullYear(), m: new Date().getMonth() },

  // --- Hojas base ---
  servicios: [],      // hoja 1
  facturacion: [],    // hoja 2  (1 fila por servicio, ligada por svcId)
  operarios: [],      // hoja 3
  supervisores: [],   // hoja 4
  distribucion: [],   // hoja 5  (1 fila por servicio, con array de turnos)
  movimientos: [],    // hoja 8
  reclamos: [],       // hoja 9  (reclamos de facturación)

  // --- Auth ---
  auth: {
    perfil: null,     // "rrhh" | "facturacion" | "jefe" | "supervisor"
    usuario: null,    // nombre mostrado
    supervisorId: null, // P-id si es supervisor
  },

  // --- Contadores de ID (para prefijos únicos) ---
  contadores: { S: 0, O: 0, P: 0, M: 0, R: 0 },
};

// ============================================================
// USUARIOS Y PERMISOS
// ============================================================
// Los supervisores reales viven en APP.supervisores (hoja 4) con su ID P.
// Estos son los accesos de login. Las claves se pueden cambiar desde Config.
const USUARIOS_LOGIN = {
  rrhh:        { nombre: "RRHH",           perfil: "rrhh",        clave: "cleanit2024" },
  facturacion: { nombre: "Facturación",    perfil: "facturacion", clave: "factura2024" },
};

const PERMISOS = {
  rrhh: {
    screens: ["servicios","operarios","personal","distribucion","control","movimientos","prefac","reclamos","config"],
    editar: true, verValores: true, verFacturacion: true, darBaja: true, configurar: true, verTodo: true,
  },
  facturacion: {
    screens: ["servicios","prefac","movimientos","reclamos"],
    editar: false, verValores: true, verFacturacion: true, darBaja: false, configurar: false, verTodo: true,
  },
  jefe: {
    screens: ["servicios","control","movimientos"],
    editar: false, verValores: false, verFacturacion: false, darBaja: false, configurar: false, verTodo: true,
  },
  supervisor: {
    screens: ["servicios","control"],
    editar: false, verValores: false, verFacturacion: false, darBaja: false, configurar: false, verTodo: false,
  },
};

function puedeVer(screen){ const p=APP.auth.perfil; return p ? PERMISOS[p].screens.includes(screen) : false; }
function tienePermiso(k){ const p=APP.auth.perfil; return p ? PERMISOS[p][k]===true : false; }

// ============================================================
// IDs CON PREFIJO — nunca se reutilizan, nunca se confunden
// ============================================================
function nuevoId(prefijo){
  APP.contadores[prefijo] = (APP.contadores[prefijo]||0) + 1;
  const n = String(APP.contadores[prefijo]).padStart(prefijo==="M"?4:3, "0");
  guardarLocal();
  return prefijo + n;
}

// ============================================================
// PERSISTENCIA — localStorage + Google Sheets
// ============================================================
const LS_KEY = "cleanit_v2";
// Pegar acá la URL del Apps Script publicado (termina en /exec)
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw3whyuVsG4OwkQIMSoEc31lCDSdHqs-DiIN-bVYJq0Q4T26NNkGIyw_oFGer4kKnnH/exec";  // Apps Script publicado

function driveActivo(){ return SCRIPT_URL && SCRIPT_URL.indexOf("/exec") > 0; }

function guardarLocal(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      servicios: APP.servicios,
      facturacion: APP.facturacion,
      operarios: APP.operarios,
      supervisores: APP.supervisores,
      distribucion: APP.distribucion,
      movimientos: APP.movimientos,
      reclamos: APP.reclamos,
      contadores: APP.contadores,
    }));
  }catch(e){ console.error("Error guardando local:", e); }
}

function cargarLocal(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return false;
    const d = JSON.parse(raw);
    APP.servicios    = d.servicios    || [];
    APP.facturacion  = d.facturacion  || [];
    APP.operarios    = d.operarios    || [];
    APP.supervisores = d.supervisores || [];
    APP.distribucion = d.distribucion || [];
    APP.movimientos  = d.movimientos  || [];
    APP.reclamos     = d.reclamos     || [];
    APP.contadores   = d.contadores   || { S:0, O:0, P:0, M:0, R:0 };
    return true;
  }catch(e){ console.error("Error cargando local:", e); return false; }
}

// ---- Sincronización con Drive ----
async function cargarDeDrive(){
  if(!driveActivo()) return false;
  try{
    showLoading("⏳ Cargando desde Drive...");
    const resp = await fetch(SCRIPT_URL + "?action=getData");
    const data = await resp.json();
    if(data.ok){
      APP.servicios    = (data.servicios || []).map(normalizarServicio);
      APP.facturacion  = data.facturacion  || [];
      APP.operarios    = data.operarios    || [];
      APP.supervisores = data.supervisores || [];
      APP.distribucion = data.distribucion || [];
      APP.movimientos  = (data.movimientos || []).map(normalizarMovimiento);
      APP.reclamos     = data.reclamos || [];
      // Recalcular contadores desde los IDs existentes (para no repetir)
      recalcularContadores();
      guardarLocal();
      hideLoading();
      return true;
    }
    hideLoading();
    return false;
  }catch(e){
    console.error("Error cargando de Drive:", e);
    hideLoading();
    return false;
  }
}

function recalcularContadores(){
  const maxId = (arr, pref) => arr.reduce((mx,x) => {
    const s = String(x.id||x.svcId||"");
    if(s.startsWith(pref)){ const n=parseInt(s.slice(pref.length))||0; return Math.max(mx,n); }
    return mx;
  }, 0);
  APP.contadores = {
    S: maxId(APP.servicios, "S"),
    O: maxId(APP.operarios, "O"),
    P: maxId(APP.supervisores, "P"),
    M: maxId(APP.movimientos, "M"),
    R: maxId(APP.reclamos, "R"),
  };
}

// Guardar un servicio completo (servicios + facturacion + distribucion) en Drive
async function driveSaveServicio(svcId){
  if(!driveActivo()) return;
  const s = APP.servicios.find(x => x.id === svcId);
  if(!s) return;
  const fac = APP.facturacion.find(x => x.svcId === svcId) || {};
  const dist = APP.distribucion.find(x => x.svcId === svcId) || {turnos:[]};
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({
      action:"upsertServicio",
      servicio: {...s, facturacion: fac, distribucion: dist},
    })});
  }catch(e){ console.error("driveSaveServicio:", e); }
}

async function driveBajaServicio(id, estado, fechaBaja, motivoBaja){
  if(!driveActivo()) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({
      action:"bajaServicio", id, estado, fechaBaja, motivoBaja,
    })});
  }catch(e){ console.error("driveBajaServicio:", e); }
}

async function driveSaveOperario(id){
  if(!driveActivo()) return;
  const o = APP.operarios.find(x => x.id === id);
  if(!o) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({ action:"upsertOperario", operario:o })});
  }catch(e){ console.error(e); }
}

async function driveSaveSupervisor(id){
  if(!driveActivo()) return;
  const s = APP.supervisores.find(x => x.id === id);
  if(!s) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({ action:"upsertSupervisor", supervisor:s })});
  }catch(e){ console.error(e); }
}

async function driveAddMovimiento(mov){
  if(!driveActivo()) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({ action:"addMovimiento", movimiento:mov })});
  }catch(e){ console.error(e); }
}

async function driveDeleteMovimiento(movId){
  if(!driveActivo()) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({ action:"deleteMovimiento", id:movId })});
  }catch(e){ console.error(e); }
}

async function driveSaveReclamo(id){
  if(!driveActivo()) return;
  const r = APP.reclamos.find(x => x.id === id);
  if(!r) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({ action:"upsertReclamo", reclamo:r })});
  }catch(e){ console.error(e); }
}

async function driveDeleteReclamo(id){
  if(!driveActivo()) return;
  try{
    await fetch(SCRIPT_URL, { method:"POST", body: JSON.stringify({ action:"deleteReclamo", id:id })});
  }catch(e){ console.error(e); }
}

// ============================================================
// AUTH
// ============================================================
function intentarLogin(){
  const userKey = document.getElementById("login-usuario").value;
  const clave   = document.getElementById("login-clave").value;
  const err     = document.getElementById("login-error");

  let usr = USUARIOS_LOGIN[userKey];
  // Si no es un usuario fijo, buscar entre supervisores (hoja 4) por su ID
  if(!usr){
    const sup = APP.supervisores.find(s => s.id === userKey && s.estado === "activo");
    if(sup){
      usr = {
        nombre: sup.nombreCompleto,
        perfil: sup.cargo === "jefe" ? "jefe" : "supervisor",
        clave: sup.clave || "super2024",
        supervisorId: sup.id,
      };
    }
  }

  if(!usr || clave !== usr.clave){
    err.textContent = "Contraseña incorrecta";
    err.style.display = "block";
    return;
  }

  APP.auth.perfil = usr.perfil;
  APP.auth.usuario = usr.nombre;
  APP.auth.supervisorId = usr.supervisorId || null;
  sessionStorage.setItem("cleanit_v2_sesion", JSON.stringify(APP.auth));

  APP.screen = usr.perfil === "facturacion" ? "prefac" : "servicios";
  render();
}

function cerrarSesion(){
  APP.auth = { perfil:null, usuario:null, supervisorId:null };
  sessionStorage.removeItem("cleanit_v2_sesion");
  render();
}

function restaurarSesion(){
  try{
    const raw = sessionStorage.getItem("cleanit_v2_sesion");
    if(raw){
      const s = JSON.parse(raw);
      if(s && s.perfil){ APP.auth = s; }
    }
  }catch(e){}
}

// ============================================================
// NAVEGACIÓN
// ============================================================
const SCREENS = {
  servicios:    { titulo: "Servicios",        icono: "M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2z M4 10h16" },
  operarios:    { titulo: "Operarios",        icono: "M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 100-8 4 4 0 000 8z" },
  personal:     { titulo: "Supervisores",     icono: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" },
  distribucion: { titulo: "Distribución",     icono: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
  control:      { titulo: "Control de horas", icono: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" },
  movimientos:  { titulo: "Movimientos",      icono: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
  prefac:       { titulo: "Prefacturación",   icono: "M9 7h6m-6 4h6m-6 4h4m-8 4h12a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" },
  reclamos:     { titulo: "Reclamos",         icono: "M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.5 0L3.16 16.25A2 2 0 005 19z" },
  config:       { titulo: "Configuración",    icono: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" },
};

const NAV_GROUPS = [
  { label: "Operaciones", items: ["servicios","distribucion","control"] },
  { label: "Personal",    items: ["operarios","personal"] },
  { label: "Gestión",     items: ["movimientos","prefac","reclamos"] },
  { label: "Sistema",     items: ["config"] },
];

function go(screen){
  if(!puedeVer(screen)) return;
  APP.screen = screen;
  render();
  closeSidebar();
}

function renderNav(){
  const nav = document.getElementById("nav");
  let html = "";
  NAV_GROUPS.forEach(grupo => {
    const visibles = grupo.items.filter(s => puedeVer(s));
    if(!visibles.length) return;
    html += `<div class="nav-section">${grupo.label}</div>`;
    visibles.forEach(s => {
      const sc = SCREENS[s];
      html += `<div class="nav-item ${APP.screen===s?"active":""}" onclick="go('${s}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="${sc.icono}"/></svg>
        ${sc.titulo}
      </div>`;
    });
  });
  nav.innerHTML = html;
}

function closeSidebar(){ document.getElementById("sidebar").classList.remove("open"); }

function cerrarModal(){
  const m = document.getElementById("modal");
  if(m){ m.style.display = "none"; m.innerHTML = ""; }
}

// ============================================================
// LOADING
// ============================================================
let _loadingTimer = null;
function showLoading(msg){
  const el = document.getElementById("loading");
  el.textContent = msg;
  el.style.display = "block";
}
function hideLoading(){
  document.getElementById("loading").style.display = "none";
}

// ============================================================
// PANTALLAS — placeholders por ahora (sin funciones de negocio)
// ============================================================
function placeholder(titulo, desc, extra){
  return `<div class="card"><div class="placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
    <h3>${titulo}</h3>
    <p>${desc}</p>
    ${extra||`<span class="empty-tag">Pantalla lista — función por agregar</span>`}
  </div></div>`;
}

function facDe(svcId){ return APP.facturacion.find(f => f.svcId === svcId) || {}; }
function distDe(svcId){ return APP.distribucion.find(d => d.svcId === svcId) || { svcId, turnos:[] }; }

const DIAS_LETRA = ["Do","Lu","Ma","Mi","Ju","Vi","Sá"];
function resumenDias(dias){
  if(!dias || !dias.length) return "—";
  return dias.slice().sort((a,b)=>a-b).map(d => DIAS_LETRA[d]).join("·");
}
function resumenDist(svcId){
  const d = distDe(svcId);
  if(!d.turnos || !d.turnos.length) return "Sin distribución";
  if(d.turnos.length === 1){
    const t = d.turnos[0];
    return `${resumenDias(t.dias)} ${t.entrada||""}-${t.salida||""}`;
  }
  return `${d.turnos.length} turnos`;
}

function renderServicios(){
  const activos = APP.servicios.filter(s => s.estado === "activo")
    .sort((a,b) => a.nombre.localeCompare(b.nombre,"es"));

  const filas = activos.map(s => {
    const fac = facDe(s.id);
    const verVal = tienePermiso("verValores");
    return `<tr>
      <td style="font-family:monospace;font-size:11px;color:var(--text3)">${s.id}</td>
      <td><strong>${s.nombre}</strong><br><span style="font-size:10px;color:var(--text3)">${s.tipo||"Consorcio"}</span></td>
      <td style="font-size:11px;color:var(--text2)">${nombreSup(s.supervisorId)}</td>
      <td style="font-size:11px;font-family:monospace">${resumenDist(s.id)}</td>
      ${verVal?`<td style="font-family:monospace;font-size:11px">${fac.valorHora?"$"+Number(fac.valorHora).toLocaleString("es-AR"):"—"}</td>`:`<td style="color:var(--text3)">—</td>`}
      <td style="white-space:nowrap">
        <button class="btn btn-sm" onclick="editarServicio('${s.id}')">${tienePermiso("editar")?"Ver / Editar":"Ver"}</button>
        ${tienePermiso("darBaja")?`<button class="btn btn-sm" onclick="bajaServicio('${s.id}')" style="color:var(--red-txt)">Baja</button>`:""}
      </td>
    </tr>`;
  }).join("");

  return `${tienePermiso("editar")?`<div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <button class="btn btn-primary" onclick="nuevoServicio()">+ Nuevo servicio</button>
    </div>`:""}
    <div class="card"><div class="card-header"><h3>Servicios</h3>
      <span style="font-size:11px;color:var(--text3)">${activos.length} activo(s)</span></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">ID</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Servicio</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Supervisor</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Distribución</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Valor hora</th>
        <th style="padding:9px 14px"></th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">No hay servicios cargados todavía.</td></tr>`}</tbody>
    </table></div></div>`;
}

function nombreSup(id){
  if(!id) return "—";
  const s = APP.supervisores.find(x => x.id === id);
  return s ? s.nombreCompleto : "—";
}

// --- Formulario de servicio (form en pantalla completa, no modal) ---
let FORM_SVC = null;

function nuevoServicio(){
  FORM_SVC = {
    id: null,
    nombre:"", tipo:"Consorcio", cuit:"", mail:"", razonSocial:"",
    supervisorId:"", fechaInicio: hoyISO(),
    // facturación
    valorHora:0, tipoFactura:"A", tipoContrato:"horas", montoFijo:0,
    // distribución
    turnos:[ nuevoTurno() ],
  };
  APP.screen = "form-svc";
  render();
}

function editarServicio(id){
  const s = APP.servicios.find(x => x.id === id);
  if(!s){ alert("No se encontró el servicio"); return; }
  const fac = facDe(id);
  const dist = distDe(id);
  FORM_SVC = {
    id: s.id,
    nombre: s.nombre, tipo: s.tipo||"Consorcio", cuit: s.cuit||"", mail: s.mail||"", razonSocial: s.razonSocial||"",
    supervisorId: s.supervisorId||"", fechaInicio: s.fechaInicio||"",
    valorHora: fac.valorHora||0, tipoFactura: fac.tipoFactura||"A",
    tipoContrato: fac.tipoContrato||"horas", montoFijo: fac.montoFijo||0,
    turnos: dist.turnos && dist.turnos.length ? JSON.parse(JSON.stringify(dist.turnos)) : [ nuevoTurno() ],
  };
  APP.screen = "form-svc";
  render();
}

function nuevoTurno(){
  return {
    id: "T" + Date.now() + Math.floor(Math.random()*1000),
    nombre: "Turno",
    frecuencia: "semanal",
    dias: [1,2,3,4,5],
    entrada: "08:00",
    salida: "12:00",
    horarioPorDia: {},  // { 6: {entrada:"08:00", salida:"10:00"} } — sobrescribe días puntuales
    operarioId: "",
  };
}

// Devuelve el horario real de un día para un turno (día puntual o base)
function horarioDia(turno, dw){
  const esp = (turno.horarioPorDia||{})[dw];
  if(esp && esp.entrada && esp.salida) return { entrada:esp.entrada, salida:esp.salida };
  return { entrada:turno.entrada, salida:turno.salida };
}

function renderFormSvc(){
  const f = FORM_SVC;
  if(!f) return renderServicios();
  const esNuevo = !f.id;
  const puedeEditar = tienePermiso("editar");
  const verValores = tienePermiso("verValores");
  const dis = puedeEditar ? "" : "disabled";
  const supsOpts = APP.supervisores.filter(s=>s.estado==="activo")
    .map(s=>`<option value="${s.id}" ${f.supervisorId===s.id?"selected":""}>${s.nombreCompleto}</option>`).join("");
  const opsOpts = (sel) => APP.operarios.filter(o=>o.estado==="activo")
    .map(o=>`<option value="${o.id}" ${sel===o.id?"selected":""}>${o.nombreCompleto}</option>`).join("");

  const turnos = f.turnos.map((t,i) => `
    <div class="card" style="margin-bottom:10px;border:0.5px solid var(--border)">
      <div style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;background:var(--surface2);border-bottom:0.5px solid var(--border)">
        <input type="text" value="${t.nombre}" onchange="upTurno(${i},'nombre',this.value)" ${dis}
          style="border:none;background:transparent;font-weight:600;font-size:13px;color:var(--text);width:60%">
        ${puedeEditar&&f.turnos.length>1?`<button class="btn btn-sm" onclick="quitarTurno(${i})" style="color:var(--red-txt)">Quitar turno</button>`:""}
      </div>
      <div style="padding:14px">
        <div style="margin-bottom:12px">
          <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Días</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${[1,2,3,4,5,6,0].map(d=>`
              <button ${puedeEditar?`onclick="toggleDiaTurno(${i},${d})"`:"disabled"}
                style="width:38px;height:34px;border-radius:6px;border:1px solid ${t.dias.includes(d)?'var(--primary)':'var(--border2)'};
                background:${t.dias.includes(d)?'var(--primary)':'var(--surface)'};color:${t.dias.includes(d)?'#fff':'var(--text2)'};
                font-size:12px;font-weight:500;${puedeEditar?"":"cursor:default"}">${DIAS_LETRA[d]}</button>`).join("")}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div>
            <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Entrada (base)</label>
            <input type="time" value="${t.entrada}" onchange="upTurno(${i},'entrada',this.value)" ${dis}
              style="width:100%;padding:8px 10px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Salida (base)</label>
            <input type="time" value="${t.salida}" onchange="upTurno(${i},'salida',this.value)" ${dis}
              style="width:100%;padding:8px 10px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
          </div>
        </div>

        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <label style="font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px">Horario por día</label>
            <span style="font-size:10px;color:var(--text3)">solo tocá los días distintos al base</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${t.dias.slice().sort((a,b)=>{const o={1:1,2:2,3:3,4:4,5:5,6:6,0:7};return o[a]-o[b];}).map(dw=>{
              const esp = (t.horarioPorDia||{})[dw];
              const activo = !!(esp && esp.entrada && esp.salida);
              const h = activo ? esp : {entrada:t.entrada, salida:t.salida};
              return `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
                <span style="width:28px;font-weight:${activo?'600':'400'};color:${activo?'var(--primary)':'var(--text2)'}">${DIAS_LETRA[dw]}</span>
                <input type="time" value="${h.entrada}" ${dis} onchange="setHorarioDia(${i},${dw},'entrada',this.value)"
                  style="padding:5px 8px;border:1px solid ${activo?'var(--primary)':'var(--border2)'};border-radius:6px;font-size:12px;width:100px">
                <span style="color:var(--text3)">a</span>
                <input type="time" value="${h.salida}" ${dis} onchange="setHorarioDia(${i},${dw},'salida',this.value)"
                  style="padding:5px 8px;border:1px solid ${activo?'var(--primary)':'var(--border2)'};border-radius:6px;font-size:12px;width:100px">
                ${activo?`<button ${puedeEditar?`onclick="limpiarHorarioDia(${i},${dw})"`:"disabled"} class="btn btn-sm" style="font-size:10px;padding:3px 8px">usar base</button>`:`<span style="font-size:10px;color:var(--text3)">= base</span>`}
              </div>`;
            }).join("") || '<span style="font-size:11px;color:var(--text3)">Elegí días primero</span>'}
          </div>
        </div>

        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Operario asignado</label>
          <select onchange="upTurno(${i},'operarioId',this.value)" ${dis}
            style="width:100%;padding:8px 10px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
            <option value="">— Sin asignar —</option>
            ${opsOpts(t.operarioId)}
          </select>
        </div>
      </div>
    </div>`).join("");

  const campo = (label, id, val, tipo="text", ph="") =>
    `<div style="margin-bottom:14px"><label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">${label}</label>
     <input id="${id}" type="${tipo}" value="${val}" placeholder="${ph}" ${dis}
       style="width:100%;padding:9px 12px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px"></div>`;

  return `<div style="max-width:720px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <button class="btn btn-sm" onclick="APP.screen='servicios';FORM_SVC=null;render()">‹ Volver</button>
      <h2 style="font-size:16px;font-weight:500">${esNuevo?"Nuevo servicio":(puedeEditar?"Editar ":"")+f.nombre}</h2>
    </div>

    <div class="card"><div class="card-header"><h3>Datos del servicio</h3></div>
    <div style="padding:18px">
      ${campo("Nombre","svc-nombre",f.nombre,"text","Ej: Agrelo 3641")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${campo("Tipo","svc-tipo",f.tipo,"text","Consorcio")}
        ${campo("CUIT","svc-cuit",f.cuit,"text","30-12345678-9")}
      </div>
      ${campo("Razón social","svc-razon",f.razonSocial,"text","")}
      ${campo("Mail","svc-mail",f.mail,"email","")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Supervisor</label>
          <select id="svc-supervisor" ${dis} style="width:100%;padding:9px 12px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
            <option value="">— Sin asignar —</option>${supsOpts}
          </select>
        </div>
        <div><label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Fecha de inicio</label>
          <input id="svc-fechaInicio" type="date" value="${f.fechaInicio||""}" ${dis} style="width:100%;padding:9px 12px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
        </div>
      </div>
    </div></div>

    ${verValores?`<div class="card"><div class="card-header"><h3>Facturación</h3></div>
    <div style="padding:18px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div><label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Tipo de contrato</label>
          <select id="svc-tipoContrato" ${dis} onchange="sincronizarFormDesdeDOM();FORM_SVC.tipoContrato=this.value;render()" style="width:100%;padding:9px 12px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
            <option value="horas" ${f.tipoContrato==="horas"?"selected":""}>Por horas</option>
            <option value="fijo" ${f.tipoContrato==="fijo"?"selected":""}>Monto fijo</option>
          </select></div>
        <div><label style="font-size:11px;font-weight:600;color:var(--text2);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px">Tipo de factura</label>
          <select id="svc-tipoFactura" ${dis} style="width:100%;padding:9px 12px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px">
            <option value="A" ${f.tipoFactura==="A"?"selected":""}>Tipo A</option>
            <option value="B" ${f.tipoFactura==="B"?"selected":""}>Tipo B</option>
          </select></div>
      </div>
      ${f.tipoContrato==="fijo"
        ? campo("Monto fijo mensual","svc-montoFijo",f.montoFijo,"number","")
        : campo("Valor hora","svc-valorHora",f.valorHora,"number","")}
    </div></div>`:""}

    <div class="card"><div class="card-header"><h3>Distribución — turnos</h3>
      ${puedeEditar?`<button class="btn btn-sm btn-primary" onclick="agregarTurno()">+ Agregar turno</button>`:""}</div>
    <div style="padding:18px">${turnos}</div></div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-bottom:40px">
      <button class="btn" onclick="APP.screen='servicios';FORM_SVC=null;render()">${puedeEditar?"Cancelar":"Volver"}</button>
      ${puedeEditar?`<button class="btn btn-primary" onclick="guardarServicio()">${esNuevo?"Crear servicio":"Guardar cambios"}</button>`:""}
    </div>
  </div>`;
}

function upTurno(i, campo, val){ FORM_SVC.turnos[i][campo] = val; }
function setHorarioDia(i, dw, campo, val){
  if(!FORM_SVC.turnos[i].horarioPorDia) FORM_SVC.turnos[i].horarioPorDia = {};
  const hpd = FORM_SVC.turnos[i].horarioPorDia;
  if(!hpd[dw]) hpd[dw] = { entrada: FORM_SVC.turnos[i].entrada, salida: FORM_SVC.turnos[i].salida };
  hpd[dw][campo] = val;
  render();
}
function limpiarHorarioDia(i, dw){
  sincronizarFormDesdeDOM();
  if(FORM_SVC.turnos[i].horarioPorDia) delete FORM_SVC.turnos[i].horarioPorDia[dw];
  render();
}
function toggleDiaTurno(i, dia){
  sincronizarFormDesdeDOM();
  const dias = FORM_SVC.turnos[i].dias;
  FORM_SVC.turnos[i].dias = dias.includes(dia) ? dias.filter(d=>d!==dia) : [...dias, dia];
  render();
}
function agregarTurno(){ sincronizarFormDesdeDOM(); FORM_SVC.turnos.push(nuevoTurno()); render(); }
function quitarTurno(i){ sincronizarFormDesdeDOM(); FORM_SVC.turnos.splice(i,1); render(); }

function sincronizarFormDesdeDOM(){
  const g = id => document.getElementById(id);
  if(g("svc-nombre")) FORM_SVC.nombre = g("svc-nombre").value.trim();
  if(g("svc-tipo")) FORM_SVC.tipo = g("svc-tipo").value.trim();
  if(g("svc-cuit")) FORM_SVC.cuit = g("svc-cuit").value.trim();
  if(g("svc-razon")) FORM_SVC.razonSocial = g("svc-razon").value.trim();
  if(g("svc-mail")) FORM_SVC.mail = g("svc-mail").value.trim();
  if(g("svc-supervisor")) FORM_SVC.supervisorId = g("svc-supervisor").value;
  if(g("svc-fechaInicio")) FORM_SVC.fechaInicio = g("svc-fechaInicio").value;
  if(g("svc-tipoFactura")) FORM_SVC.tipoFactura = g("svc-tipoFactura").value;
  if(g("svc-valorHora")) FORM_SVC.valorHora = parseFloat(g("svc-valorHora").value)||0;
  if(g("svc-montoFijo")) FORM_SVC.montoFijo = parseFloat(g("svc-montoFijo").value)||0;
}

function guardarServicio(){
  sincronizarFormDesdeDOM();
  const f = FORM_SVC;
  if(!f.nombre){ alert("Ingresá el nombre del servicio"); return; }
  // Validar horarios
  for(const t of f.turnos){
    if(t.entrada && t.salida && t.entrada >= t.salida){
      alert(`El turno "${t.nombre}" tiene un horario inválido (la salida debe ser posterior a la entrada).`);
      return;
    }
  }

  let svcId = f.id;
  if(svcId){
    // Actualizar servicio existente — cada hoja por separado
    APP.servicios = APP.servicios.map(s => s.id===svcId
      ? {...s, nombre:f.nombre, tipo:f.tipo, cuit:f.cuit, mail:f.mail, razonSocial:f.razonSocial, supervisorId:f.supervisorId, fechaInicio:f.fechaInicio}
      : s);
  } else {
    svcId = nuevoId("S");
    APP.servicios.push({
      id: svcId, nombre:f.nombre, tipo:f.tipo, cuit:f.cuit, mail:f.mail,
      razonSocial:f.razonSocial, supervisorId:f.supervisorId, fechaInicio:f.fechaInicio,
      estado:"activo", fechaBaja:"", motivoBaja:"",
    });
  }

  // Facturación (hoja 2) — upsert por svcId
  const facData = { svcId, valorHora:f.valorHora, tipoFactura:f.tipoFactura, tipoContrato:f.tipoContrato, montoFijo:f.montoFijo };
  const iFac = APP.facturacion.findIndex(x => x.svcId === svcId);
  if(iFac >= 0) APP.facturacion[iFac] = facData; else APP.facturacion.push(facData);

  // Distribución (hoja 5) — upsert por svcId
  const distData = { svcId, turnos: f.turnos };
  const iDist = APP.distribucion.findIndex(x => x.svcId === svcId);
  if(iDist >= 0) APP.distribucion[iDist] = distData; else APP.distribucion.push(distData);

  guardarLocal();
  driveSaveServicio(svcId);
  FORM_SVC = null;
  APP.screen = "servicios";
  render();
}

function bajaServicio(id){
  const s = APP.servicios.find(x => x.id === id);
  if(!s) return;
  const fecha = prompt(`Fecha de baja de "${s.nombre}" (YYYY-MM-DD):`, new Date().toISOString().slice(0,10));
  if(!fecha) return;
  const motivo = prompt("Motivo de la baja:", "Cambio de proveedor") || "";
  APP.servicios = APP.servicios.map(x => x.id===id
    ? {...x, estado:"inactivo", fechaBaja:fecha, motivoBaja:motivo} : x);
  guardarLocal();
  driveBajaServicio(id, "inactivo", fecha, motivo);
  render();
}
function renderOperarios(){
  const activos = APP.operarios.filter(o => o.estado === "activo")
    .sort((a,b) => a.nombreCompleto.localeCompare(b.nombreCompleto,"es"));
  const filas = activos.map(o => `<tr>
    <td style="font-family:monospace;font-size:11px;color:var(--text3)">${o.id}</td>
    <td><strong>${o.nombreCompleto}</strong></td>
    <td>${o.jornada==="completa"?'<span class="tag" style="background:var(--green-bg);color:var(--green-txt);font-size:11px;padding:2px 8px;border-radius:20px">Completa</span>':'<span class="tag" style="background:var(--gray-bg);color:var(--gray-txt);font-size:11px;padding:2px 8px;border-radius:20px">Reducida</span>'}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm" onclick="verPlanillaOperario('${o.id}')">Planilla</button>
      <button class="btn btn-sm" onclick="editarOperario('${o.id}')">Editar</button>
      <button class="btn btn-sm" onclick="bajaOperario('${o.id}')" style="color:var(--red-txt)">Baja</button>
    </td>
  </tr>`).join("");

  return `<div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <button class="btn btn-primary" onclick="nuevoOperario()">+ Nuevo operario</button>
    </div>
    <div class="card"><div class="card-header"><h3>Operarios</h3>
      <span style="font-size:11px;color:var(--text3)">${activos.length} activo(s)</span></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">ID</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Nombre completo</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Jornada</th>
        <th style="padding:9px 14px"></th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text3)">No hay operarios cargados todavía.</td></tr>`}</tbody>
    </table></div></div>`;
}

function nuevoOperario(){ abrirModalOperario(null); }
function editarOperario(id){ abrirModalOperario(id); }

function abrirModalOperario(id){
  const op = id ? APP.operarios.find(o => o.id === id) : null;
  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="cerrarModal()"></div>
    <div class="modal-box">
      <div class="modal-title">${op ? "Editar" : "Nuevo"} operario</div>
      <div class="modal-field">
        <label>Nombre completo</label>
        <input id="op-nombre" type="text" value="${op?op.nombreCompleto:""}" placeholder="Ej: Toledo Walter">
      </div>
      <div class="modal-field">
        <label>Jornada</label>
        <select id="op-jornada">
          <option value="reducida" ${op&&op.jornada==="reducida"?"selected":""}>Reducida</option>
          <option value="completa" ${op&&op.jornada==="completa"?"selected":""}>Completa</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="cerrarModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarOperario('${id||""}')">${op?"Guardar":"Crear"}</button>
      </div>
    </div>`;
  modal.style.display = "flex";
}

function guardarOperario(id){
  const nombre  = document.getElementById("op-nombre").value.trim();
  const jornada = document.getElementById("op-jornada").value;
  if(!nombre){ alert("Ingresá el nombre completo"); return; }

  if(id){
    APP.operarios = APP.operarios.map(o => o.id===id ? {...o, nombreCompleto:nombre, jornada} : o);
  } else {
    APP.operarios.push({
      id: nuevoId("O"),
      nombreCompleto: nombre,
      jornada,
      estado: "activo",
    });
  }
  guardarLocal();
  driveSaveOperario(id || APP.operarios[APP.operarios.length-1].id);
  cerrarModal();
  render();
}

function bajaOperario(id){
  const op = APP.operarios.find(o => o.id === id);
  if(!op) return;
  if(!confirm(`¿Dar de baja a ${op.nombreCompleto}?`)) return;
  APP.operarios = APP.operarios.map(o => o.id===id ? {...o, estado:"inactivo"} : o);
  guardarLocal();
  driveSaveOperario(id);
  render();
}

// ============================================================
// PLANILLA POR OPERARIO — dónde estuvo y cuántas horas en el mes
// ============================================================
let OPERARIO_SEL = null;

function verPlanillaOperario(id){
  OPERARIO_SEL = id;
  APP.screen = "planilla-op";
  render();
}

// Recorre todos los servicios y junta los días donde este operario trabajó
function datosPlanillaOperario(opId, y, m){
  const porServicio = {}; // svcId → {svc, dias:[...], totales}
  APP.servicios.filter(s => s.estado==="activo").forEach(svc => {
    const filas = planillaServicio(svc.id, y, m);
    filas.forEach(f => f.turnos.forEach(t => {
      const esTitular = t.turno.operarioId === opId;
      const esReemplazo = t.mov && t.mov.reemplazoId === opId;
      const titularNoTrabajo = t.mov && (t.mov.tipo==="ausencia" || t.mov.tipo==="reemplazo");

      let cuenta = false, hs = 0, rol = "";
      if(esReemplazo){ cuenta = true; hs = t.hs; rol = "reemplazo"; }
      else if(esTitular && !titularNoTrabajo && t.estado!=="futuro" && t.estado!=="feriado_no_trab"){ cuenta = true; hs = t.hs; rol = "titular"; }

      if(cuenta){
        if(!porServicio[svc.id]) porServicio[svc.id] = { svc, dias:[], totalHs:0, hsSimples:0, hsFeriado:0 };
        // Horario real del día
        const hor = (t.mov && t.mov.entrada && t.mov.salida) ? {entrada:t.mov.entrada, salida:t.mov.salida} : (t.horario||{entrada:"",salida:""});
        porServicio[svc.id].dias.push({
          iso:f.iso, d:f.d, dw:f.dw, turno:t.turno.nombre, hs, estado:t.estado, rol,
          feriado:f.feriado, entrada:hor.entrada, salida:hor.salida,
        });
        porServicio[svc.id].totalHs += hs;
        if(t.estado==="feriado_trab") porServicio[svc.id].hsFeriado += hs;
        else porServicio[svc.id].hsSimples += hs;
      }
    }));
  });
  return porServicio;
}

function renderPlanillaOperario(){
  const op = APP.operarios.find(o => o.id === OPERARIO_SEL);
  if(!op){ APP.screen="operarios"; return renderOperarios(); }

  const navMes = `<div style="display:flex;align-items:center;gap:10px">
    <button class="btn btn-sm" onclick="cambiarMes(-1)">‹</button>
    <span style="font-size:14px;font-weight:500;min-width:120px;text-align:center">${MESES[APP.mes.m]} ${APP.mes.y}</span>
    <button class="btn btn-sm" onclick="cambiarMes(1)">›</button>
  </div>`;

  const datos = datosPlanillaOperario(op.id, APP.mes.y, APP.mes.m);
  const servicios = Object.values(datos).sort((a,b)=>a.svc.nombre.localeCompare(b.svc.nombre,"es"));
  const totalGeneral = servicios.reduce((a,s)=>a+s.totalHs,0);
  const totalSimples = servicios.reduce((a,s)=>a+s.hsSimples,0);
  const totalFeriado = servicios.reduce((a,s)=>a+s.hsFeriado,0);

  const DIAS_LARGO = ["DOMINGO","LUNES","MARTES","MIÉRCOLES","JUEVES","VIERNES","SÁBADO"];
  const diasMes = diasDelMes(APP.mes.y, APP.mes.m);

  const bloques = servicios.map((s, idx) => {
    // Indexar los días trabajados por iso para cruzar con el calendario completo
    const porIso = {};
    s.dias.forEach(dd => { porIso[dd.iso] = dd; });

    const filasDias = diasMes.map(({d,dw,iso}) => {
      const dd = porIso[iso];
      const fer = esFeriado(iso);
      const esDomingo = dw === 0;
      const bg = fer ? "background:#FCF3D9;" : (esDomingo ? "background:#FBE4D5;" : "");
      const entrada = dd ? dd.entrada : "";
      const salida = dd ? dd.salida : "";
      const hs = dd ? dd.hs : 0;
      const obs = dd && dd.rol==="reemplazo" ? "Cubrió" : "";
      return `<tr style="${bg}">
        <td style="padding:5px 10px;font-family:monospace;font-size:11px;border:0.5px solid var(--border)">${String(d).padStart(2,"0")}/${String(APP.mes.m+1).padStart(2,"0")}/${APP.mes.y}</td>
        <td style="padding:5px 10px;font-size:11px;border:0.5px solid var(--border)">${DIAS_LARGO[dw]}</td>
        <td style="padding:5px 10px;font-family:monospace;font-size:11px;text-align:center;border:0.5px solid var(--border)">${entrada}</td>
        <td style="padding:5px 10px;font-family:monospace;font-size:11px;text-align:center;border:0.5px solid var(--border)">${salida}</td>
        <td style="padding:5px 10px;font-size:10px;text-align:center;color:var(--amber-txt);border:0.5px solid var(--border)">${fer?"FERIADO":""}</td>
        <td style="padding:5px 10px;font-size:10px;border:0.5px solid var(--border)">${obs}</td>
        <td style="padding:5px 10px;font-family:monospace;font-size:11px;text-align:right;border:0.5px solid var(--border)">${fmtHoras(hs)}</td>
      </tr>`;
    }).join("");

    return `<div class="card" style="overflow:hidden">
      <div class="card-header" style="background:var(--surface2)">
        <h3>${servicios.length>1?`Servicio ${idx+1} · `:""}${s.svc.nombre}</h3>
        <span style="font-size:12px;color:var(--text2)">${fmtHoras(s.totalHs)} hs</span></div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--surface2)">
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border);text-align:left">Fecha</th>
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border);text-align:left">Día</th>
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border)">Entrada</th>
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border)">Salida</th>
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border)">Feriado</th>
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border);text-align:left">Obs</th>
          <th style="padding:6px 10px;font-size:9px;color:var(--text3);text-transform:uppercase;border:0.5px solid var(--border);text-align:right">Horas</th>
        </tr></thead>
        <tbody>${filasDias}</tbody>
        <tfoot><tr style="background:var(--surface2);font-weight:600">
          <td colspan="6" style="padding:6px 10px;text-align:right;font-size:11px;border:0.5px solid var(--border)">Total del servicio</td>
          <td style="padding:6px 10px;text-align:right;font-family:monospace;font-size:12px;border:0.5px solid var(--border)">${fmtHoras(s.totalHs)}</td>
        </tr></tfoot>
      </table></div>
    </div>`;
  }).join("");

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn btn-sm" onclick="OPERARIO_SEL=null;APP.screen='operarios';render()">‹ Volver</button>
        <h2 style="font-size:16px;font-weight:500">${op.nombreCompleto}</h2>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn btn-sm" onclick="descargarPlanillaOperario('${op.id}')">⬇️ Excel</button>
        ${navMes}
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs simples</div><div style="font-size:22px;font-weight:500;color:var(--primary)">${fmtHoras(totalSimples)}</div></div>
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs feriado</div><div style="font-size:22px;font-weight:500">${fmtHoras(totalFeriado)}</div></div>
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Total hs</div><div style="font-size:22px;font-weight:500">${fmtHoras(totalGeneral)}</div></div>
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Servicios</div><div style="font-size:22px;font-weight:500">${servicios.length}</div></div>
    </div>
    ${bloques || `<div class="card"><div class="placeholder"><h3>Sin actividad</h3><p>${op.nombreCompleto} no tiene días registrados en ${MESES[APP.mes.m]} ${APP.mes.y}.</p></div></div>`}`;
}

// Descarga la planilla del operario en Excel (CSV), separada por servicio
function descargarPlanillaOperario(opId){
  const op = APP.operarios.find(o => o.id === opId);
  if(!op) return;
  const datos = datosPlanillaOperario(opId, APP.mes.y, APP.mes.m);
  const servicios = Object.values(datos).sort((a,b)=>a.svc.nombre.localeCompare(b.svc.nombre,"es"));
  const DIAS_LARGO = ["DOMINGO","LUNES","MARTES","MIÉRCOLES","JUEVES","VIERNES","SÁBADO"];
  const diasMes = diasDelMes(APP.mes.y, APP.mes.m);

  let lineas = [];
  lineas.push(`Planilla de operario;${op.nombreCompleto}`);
  lineas.push(`Período;${MESES[APP.mes.m]} ${APP.mes.y}`);
  lineas.push("");

  if(!servicios.length){
    lineas.push("Sin actividad registrada este mes.");
  }

  servicios.forEach((s, idx) => {
    lineas.push(`${servicios.length>1?`SERVICIO ${idx+1} - `:""}${s.svc.nombre}`);
    lineas.push("Fecha;Día;Entrada;Salida;Feriado;Obs;Horas");
    const porIso = {};
    s.dias.forEach(dd => { porIso[dd.iso] = dd; });
    diasMes.forEach(({d,dw,iso}) => {
      const dd = porIso[iso];
      const fer = esFeriado(iso);
      const fecha = `${String(d).padStart(2,"0")}/${String(APP.mes.m+1).padStart(2,"0")}/${APP.mes.y}`;
      lineas.push([
        fecha, DIAS_LARGO[dw], dd?dd.entrada:"", dd?dd.salida:"",
        fer?"FERIADO":"", (dd&&dd.rol==="reemplazo")?"Cubrió":"", dd?fmtHoras(dd.hs):"0",
      ].join(";"));
    });
    lineas.push(`;;;;;;`);
    lineas.push(`;;;;;Total ${s.svc.nombre};${fmtHoras(s.totalHs)}`);
    lineas.push("");
  });

  const totalGeneral = servicios.reduce((a,s)=>a+s.totalHs,0);
  lineas.push(`;;;;;TOTAL GENERAL;${fmtHoras(totalGeneral)}`);

  descargarCSV(lineas, `Planilla_${op.nombreCompleto.replace(/[^a-zA-Z0-9]/g,"_")}_${MESES[APP.mes.m]}_${APP.mes.y}.csv`);
}
function renderPersonal(){
  const activos = APP.supervisores.filter(s => s.estado === "activo")
    .sort((a,b) => a.nombreCompleto.localeCompare(b.nombreCompleto,"es"));
  const filas = activos.map(s => `<tr>
    <td style="font-family:monospace;font-size:11px;color:var(--text3)">${s.id}</td>
    <td><strong>${s.nombreCompleto}</strong></td>
    <td>${s.cargo==="jefe"?'<span class="tag" style="background:var(--purple-bg);color:var(--purple-txt);font-size:11px;padding:2px 8px;border-radius:20px">Jefe operativo</span>':'<span class="tag" style="background:var(--blue-bg);color:var(--blue-txt);font-size:11px;padding:2px 8px;border-radius:20px">Supervisor</span>'}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm" onclick="editarSupervisor('${s.id}')">Editar</button>
      <button class="btn btn-sm" onclick="bajaSupervisor('${s.id}')" style="color:var(--red-txt)">Baja</button>
    </td>
  </tr>`).join("");

  return `<div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <button class="btn btn-primary" onclick="nuevoSupervisor()">+ Nuevo supervisor</button>
    </div>
    <div class="card"><div class="card-header"><h3>Supervisores y jefes operativos</h3>
      <span style="font-size:11px;color:var(--text3)">${activos.length} activo(s)</span></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">ID</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Nombre completo</th>
        <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Cargo</th>
        <th style="padding:9px 14px"></th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text3)">No hay supervisores cargados todavía.</td></tr>`}</tbody>
    </table></div></div>`;
}

function nuevoSupervisor(){ abrirModalSupervisor(null); }
function editarSupervisor(id){ abrirModalSupervisor(id); }

function abrirModalSupervisor(id){
  const sup = id ? APP.supervisores.find(s => s.id === id) : null;
  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="cerrarModal()"></div>
    <div class="modal-box">
      <div class="modal-title">${sup ? "Editar" : "Nuevo"} supervisor</div>
      <div class="modal-field">
        <label>Nombre completo</label>
        <input id="sup-nombre" type="text" value="${sup?sup.nombreCompleto:""}" placeholder="Ej: Pereyra Leonardo">
      </div>
      <div class="modal-field">
        <label>Cargo</label>
        <select id="sup-cargo">
          <option value="supervisor" ${sup&&sup.cargo==="supervisor"?"selected":""}>Supervisor</option>
          <option value="jefe" ${sup&&sup.cargo==="jefe"?"selected":""}>Jefe operativo</option>
        </select>
      </div>
      ${sup?"":`<div class="modal-hint">Se crea con la contraseña <strong>super2024</strong>. Se puede cambiar después.</div>`}
      <div class="modal-actions">
        <button class="btn" onclick="cerrarModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarSupervisor('${id||""}')">${sup?"Guardar":"Crear"}</button>
      </div>
    </div>`;
  modal.style.display = "flex";
}

function guardarSupervisor(id){
  const nombre = document.getElementById("sup-nombre").value.trim();
  const cargo  = document.getElementById("sup-cargo").value;
  if(!nombre){ alert("Ingresá el nombre completo"); return; }

  if(id){
    APP.supervisores = APP.supervisores.map(s => s.id===id ? {...s, nombreCompleto:nombre, cargo} : s);
  } else {
    APP.supervisores.push({
      id: nuevoId("P"),
      nombreCompleto: nombre,
      cargo,
      estado: "activo",
      clave: "super2024",
    });
  }
  guardarLocal();
  driveSaveSupervisor(id || APP.supervisores[APP.supervisores.length-1].id);
  cerrarModal();
  render();
}

function bajaSupervisor(id){
  const sup = APP.supervisores.find(s => s.id === id);
  if(!sup) return;
  if(!confirm(`¿Dar de baja a ${sup.nombreCompleto}?`)) return;
  APP.supervisores = APP.supervisores.map(s => s.id===id ? {...s, estado:"inactivo"} : s);
  guardarLocal();
  driveSaveSupervisor(id);
  render();
}
function renderDistribucion(){
  const activos = APP.servicios.filter(s => s.estado === "activo")
    .sort((a,b) => a.nombre.localeCompare(b.nombre,"es"));
  if(!activos.length){
    return placeholder("Distribución de servicios", "Todavía no hay servicios cargados. La distribución se define al crear cada servicio.");
  }
  const filas = activos.map(s => {
    const d = distDe(s.id);
    const turnosHtml = (d.turnos||[]).map(t => {
      const op = APP.operarios.find(o=>o.id===t.operarioId);
      return `<div style="padding:4px 0;font-size:12px">
        <strong>${t.nombre}</strong> · ${resumenDias(t.dias)} · ${t.entrada}-${t.salida}
        ${op?`· <span style="color:var(--text2)">${op.nombreCompleto}</span>`:'· <span style="color:var(--text3)">sin operario</span>'}
      </div>`;
    }).join("") || '<span style="color:var(--text3);font-size:12px">Sin turnos</span>';
    return `<tr>
      <td style="vertical-align:top;padding:12px 14px"><strong>${s.nombre}</strong><br>
        <span style="font-size:10px;color:var(--text3);font-family:monospace">${s.id}</span></td>
      <td style="padding:12px 14px">${turnosHtml}</td>
      <td style="vertical-align:top;padding:12px 14px">
        ${tienePermiso("editar")?`<button class="btn btn-sm" onclick="editarServicio('${s.id}')">Editar</button>`:""}
      </td>
    </tr>`;
  }).join("");
  return `<div class="card"><div class="card-header"><h3>Distribución de servicios</h3>
    <span style="font-size:11px;color:var(--text3)">${activos.length} servicio(s)</span></div>
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:var(--surface2)">
      <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Servicio</th>
      <th style="text-align:left;padding:9px 14px;font-size:10px;color:var(--text3);text-transform:uppercase">Turnos</th>
      <th style="padding:9px 14px"></th>
    </tr></thead>
    <tbody>${filas}</tbody>
  </table></div></div>`;
}
// ============================================================
// PLANILLA DEL MES — cruza distribución (hoja 5) con movimientos (hoja 8)
// ============================================================
function movsDe(svcId, y, m){
  const pref = isoFecha(y,m,1).slice(0,7); // "YYYY-MM"
  return APP.movimientos.filter(mv => mv.svcId===svcId && (mv.fecha||"").startsWith(pref));
}

// Normaliza fechas de un servicio a string "YYYY-MM-DD"
function normalizarServicio(s){
  const fechaStr = (v) => {
    if(!v) return "";
    if(v instanceof Date) return isoFecha(v.getFullYear(), v.getMonth(), v.getDate());
    const str = String(v).trim();
    if(str.includes("T")){ const d=new Date(str); if(!isNaN(d.getTime())) return isoFecha(d.getFullYear(),d.getMonth(),d.getDate()); }
    return str.slice(0,10);
  };
  return { ...s, fechaInicio: fechaStr(s.fechaInicio), fechaBaja: fechaStr(s.fechaBaja) };
}

// Normaliza un movimiento: fecha siempre string "YYYY-MM-DD", horarios string "HH:MM"
function normalizarMovimiento(mv){
  const fechaStr = (v) => {
    if(!v) return "";
    if(v instanceof Date) return isoFecha(v.getFullYear(), v.getMonth(), v.getDate());
    const s = String(v).trim();
    if(s.includes("T")){ const d=new Date(s); if(!isNaN(d.getTime())) return isoFecha(d.getFullYear(),d.getMonth(),d.getDate()); }
    return s.slice(0,10);
  };
  const horaStr = (v) => {
    if(!v) return "";
    if(v instanceof Date) return `${String(v.getHours()).padStart(2,"0")}:${String(v.getMinutes()).padStart(2,"0")}`;
    const s = String(v).trim();
    if(s.includes("T")){ const d=new Date(s); if(!isNaN(d.getTime())) return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }
    return s;
  };
  return { ...mv,
    fecha: fechaStr(mv.fecha),
    entrada: horaStr(mv.entrada),
    salida: horaStr(mv.salida),
  };
}

// Devuelve, para un servicio y mes, un array de filas: {iso, d, dw, feriado, turnos:[{turno, estado, hs, mov}]}
function planillaServicio(svcId, y, m){
  const dist = distDe(svcId);
  const turnos = dist.turnos || [];
  const movs = movsDe(svcId, y, m);
  const hoy = hoyISO();
  const svc = APP.servicios.find(s => s.id === svcId) || {};
  const fInicio = (svc.fechaInicio && /^\d{4}-\d{2}-\d{2}/.test(svc.fechaInicio)) ? svc.fechaInicio.slice(0,10) : null;
  const fBaja = (svc.fechaBaja && /^\d{4}-\d{2}-\d{2}/.test(svc.fechaBaja)) ? svc.fechaBaja.slice(0,10) : null;
  const filas = [];

  diasDelMes(y,m).forEach(({d,dw,iso}) => {
    // Respetar fecha de inicio y de baja del servicio
    if(fInicio && iso < fInicio) return;
    if(fBaja && iso > fBaja) return;
    const fer = esFeriado(iso);
    // Qué turnos aplican este día según su distribución
    const turnosDelDia = turnos.filter(t => (t.dias||[]).includes(dw));
    if(!turnosDelDia.length && !fer) return; // día sin actividad
    if(!turnosDelDia.length) return;

    const turnosFila = turnosDelDia.map(t => {
      // Buscar movimiento que aplique a este turno en esta fecha
      const mov = movs.find(mv => mv.turnoId===t.id && mv.fecha===iso);
      // Horario real de este día (puntual o base)
      const hd = horarioDia(t, dw);
      const hsBase = hsEntreHorarios(hd.entrada, hd.salida);
      let estado = "trabajado", hs = hsBase;
      const esPasadoOHoy = iso <= hoy;

      if(mov){
        if(mov.tipo==="ausencia"){ estado="ausente"; hs=0; }
        else if(mov.tipo==="reemplazo"){
          estado="reemplazo";
          // Si el reemplazante hizo otro horario, usar esas horas reales
          hs = (mov.entrada && mov.salida) ? hsEntreHorarios(mov.entrada, mov.salida) : hsBase;
        }
        else if(mov.tipo==="feriado_trabajado"){ estado="feriado_trab"; hs=hsBase; }
        else if(mov.tipo==="cambio_temporal"){ estado="cambio"; hs=hsEntreHorarios(mov.entrada||hd.entrada, mov.salida||hd.salida); }
      } else if(fer){
        estado="feriado_no_trab"; hs=0;
      } else if(!esPasadoOHoy){
        estado="futuro";
      }
      return { turno:t, estado, hs, mov, hsBase, horario:hd };
    });

    filas.push({ iso, d, dw, feriado:fer, turnos:turnosFila });
  });
  return filas;
}

function resumenPlanilla(svcId, y, m){
  const filas = planillaServicio(svcId, y, m);
  let hsSimples=0, hsFeriado=0, ausencias=0;
  filas.forEach(f => f.turnos.forEach(t => {
    if(t.estado==="feriado_trab") hsFeriado += t.hs;
    else hsSimples += t.hs;
    if(t.estado==="ausente") ausencias++;
  }));
  return { hsSimples, hsFeriado, ausencias, totalHs: hsSimples+hsFeriado };
}

const ESTADO_LABEL = {
  trabajado:{txt:"Trabajado",bg:"var(--green-bg)",fg:"var(--green-txt)"},
  ausente:{txt:"Ausente",bg:"var(--red-bg)",fg:"var(--red-txt)"},
  reemplazo:{txt:"Reemplazo",bg:"var(--blue-bg)",fg:"var(--blue-txt)"},
  feriado_trab:{txt:"Feriado trabajado",bg:"var(--amber-bg)",fg:"var(--amber-txt)"},
  feriado_no_trab:{txt:"Feriado",bg:"var(--gray-bg)",fg:"var(--gray-txt)"},
  cambio:{txt:"Cambio temporal",bg:"var(--purple-bg)",fg:"var(--purple-txt)"},
  futuro:{txt:"—",bg:"transparent",fg:"var(--text3)"},
};

function serviciosVisibles(){
  const todos = APP.servicios.filter(s => s.estado==="activo");
  if(tienePermiso("verTodo")) return todos;
  // supervisor: solo los suyos
  return todos.filter(s => s.supervisorId === APP.auth.supervisorId);
}

let CONTROL_SVC = null;

function renderControl(){
  const svcs = serviciosVisibles().sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
  if(!svcs.length){
    return placeholder("Control de horas", "No tenés servicios asignados para este mes.");
  }

  // Navegación de mes
  const navMes = `<div style="display:flex;align-items:center;gap:10px">
    <button class="btn btn-sm" onclick="cambiarMes(-1)">‹</button>
    <span style="font-size:14px;font-weight:500;min-width:120px;text-align:center">${MESES[APP.mes.m]} ${APP.mes.y}</span>
    <button class="btn btn-sm" onclick="cambiarMes(1)">›</button>
  </div>`;

  // Si no hay servicio seleccionado, mostrar lista
  if(!CONTROL_SVC || !svcs.find(s=>s.id===CONTROL_SVC)){
    const filas = svcs.map(s => {
      const r = resumenPlanilla(s.id, APP.mes.y, APP.mes.m);
      return `<tr onclick="CONTROL_SVC='${s.id}';render()" style="cursor:pointer">
        <td style="padding:11px 14px"><strong>${s.nombre}</strong></td>
        <td style="padding:11px 14px;font-family:monospace;font-size:12px">${fmtHoras(r.totalHs)} hs</td>
        <td style="padding:11px 14px">${r.ausencias?`<span style="color:var(--red-txt);font-size:12px">${r.ausencias} ausencia(s)</span>`:'<span style="color:var(--text3);font-size:12px">—</span>'}</td>
        <td style="padding:11px 14px;text-align:right"><span class="btn btn-sm">Ver planilla ›</span></td>
      </tr>`;
    }).join("");
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">${navMes}
        <button class="btn btn-primary" onclick="abrirFichar()">⚠️ Fichar anomalía</button></div>
      <div class="card"><div class="card-header"><h3>Servicios — ${MESES[APP.mes.m]} ${APP.mes.y}</h3></div>
      <table style="width:100%;border-collapse:collapse"><tbody>${filas}</tbody></table></div>`;
  }

  // Planilla de un servicio
  const svc = svcs.find(s=>s.id===CONTROL_SVC);
  const filas = planillaServicio(svc.id, APP.mes.y, APP.mes.m);
  const r = resumenPlanilla(svc.id, APP.mes.y, APP.mes.m);

  const puedeEditarPlanilla = tienePermiso("editar");

  const filasHtml = filas.map(f => {
    return f.turnos.map((t,ti) => {
      const el = ESTADO_LABEL[t.estado] || ESTADO_LABEL.trabajado;
      const hor = t.horario ? `${t.horario.entrada}-${t.horario.salida}` : "";
      // Si hubo reemplazo/cambio con horario propio, mostrarlo
      const horReal = (t.mov && t.mov.entrada && t.mov.salida) ? `${t.mov.entrada}-${t.mov.salida}` : hor;
      const opNom = (t.mov && t.mov.reemplazoId) ? (APP.operarios.find(o=>o.id===t.mov.reemplazoId)?.nombreCompleto||"") : "";
      return `<tr>
        ${ti===0?`<td rowspan="${f.turnos.length}" style="padding:8px 12px;font-family:monospace;font-size:12px;border-right:0.5px solid var(--border)">
          ${String(f.d).padStart(2,"0")}/${String(APP.mes.m+1).padStart(2,"0")}<br>
          <span style="font-size:10px;color:var(--text3)">${DIAS_LETRA[f.dw]}</span>
          ${f.feriado?`<br><span style="font-size:9px;color:var(--amber-txt)">${f.feriado}</span>`:""}</td>`:""}
        <td style="padding:8px 12px;font-size:12px">${t.turno.nombre}</td>
        <td style="padding:8px 12px;font-family:monospace;font-size:11px;color:var(--text2)">${horReal}${opNom?`<br><span style="font-size:10px;color:var(--blue-txt)">↳ ${opNom}</span>`:""}</td>
        <td style="padding:8px 12px"><span style="background:${el.bg};color:${el.fg};font-size:11px;padding:2px 8px;border-radius:20px">${el.txt}</span></td>
        <td style="padding:8px 12px;font-family:monospace;font-size:12px;text-align:right">${t.hs>0?fmtHoras(t.hs):"—"}</td>
        ${puedeEditarPlanilla?`<td style="padding:8px 12px;text-align:center">
          <button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="editarDiaPlanilla('${svc.id}','${t.turno.id}','${f.iso}')">✏️</button>
        </td>`:""}
      </tr>`;
    }).join("");
  }).join("");

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn btn-sm" onclick="CONTROL_SVC=null;render()">‹ Volver</button>
        <h2 style="font-size:16px;font-weight:500">${svc.nombre}</h2>
      </div>
      ${navMes}
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs simples</div><div style="font-size:22px;font-weight:500;color:var(--primary)">${fmtHoras(r.hsSimples)}</div></div>
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs feriado</div><div style="font-size:22px;font-weight:500">${fmtHoras(r.hsFeriado)}</div></div>
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Total hs</div><div style="font-size:22px;font-weight:500">${fmtHoras(r.totalHs)}</div></div>
      <div class="card" style="margin:0;padding:12px 16px"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Ausencias</div><div style="font-size:22px;font-weight:500;color:${r.ausencias?'var(--red-txt)':'var(--text)'}">${r.ausencias}</div></div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px">
      <button class="btn" onclick="descargarPlanillaServicio('${svc.id}')">⬇️ Descargar Excel</button>
      <button class="btn btn-primary" onclick="abrirFichar('${svc.id}')">⚠️ Fichar anomalía</button>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Fecha</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Turno</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Horario</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Estado</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Hs</th>
        ${puedeEditarPlanilla?`<th style="padding:8px 12px"></th>`:""}
      </tr></thead>
      <tbody>${filasHtml}</tbody>
    </table></div>`;
}

function cambiarMes(delta){
  let m = APP.mes.m + delta, y = APP.mes.y;
  if(m<0){ m=11; y--; } if(m>11){ m=0; y++; }
  APP.mes = {y,m};
  render();
}

// ============================================================
// DESCARGA DE PLANILLA DEL SERVICIO (Excel via CSV)
// ============================================================
function descargarPlanillaServicio(svcId){
  const svc = APP.servicios.find(s => s.id === svcId);
  if(!svc) return;
  const filas = planillaServicio(svcId, APP.mes.y, APP.mes.m);
  const r = resumenPlanilla(svcId, APP.mes.y, APP.mes.m);
  const fac = facDe(svcId);
  const DIAS_LARGO = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

  // Encabezado
  let lineas = [];
  lineas.push(`Planilla de servicio;${svc.nombre}`);
  if(svc.razonSocial) lineas.push(`Razón social;${svc.razonSocial}`);
  if(svc.cuit) lineas.push(`CUIT;${svc.cuit}`);
  lineas.push(`Período;${MESES[APP.mes.m]} ${APP.mes.y}`);
  lineas.push("");
  lineas.push("Fecha;Día;Turno;Horario;Estado;Operario;Horas");

  const nombreEstado = {
    trabajado:"Trabajado", ausente:"Ausente", reemplazo:"Reemplazo",
    feriado_trab:"Feriado trabajado", feriado_no_trab:"Feriado no trabajado",
    cambio:"Cambio horario", futuro:"",
  };

  filas.forEach(f => {
    // Saltar domingos sin actividad y días futuros vacíos para el cliente
    f.turnos.forEach(t => {
      if(t.estado === "futuro") return;
      const hor = (t.mov && t.mov.entrada && t.mov.salida) ? `${t.mov.entrada}-${t.mov.salida}`
                : (t.horario ? `${t.horario.entrada}-${t.horario.salida}` : "");
      const opNom = (t.mov && t.mov.reemplazoId)
                  ? (APP.operarios.find(o=>o.id===t.mov.reemplazoId)?.nombreCompleto||"")
                  : (APP.operarios.find(o=>o.id===t.turno.operarioId)?.nombreCompleto||"");
      const fechaTxt = `${String(f.d).padStart(2,"0")}/${String(APP.mes.m+1).padStart(2,"0")}/${APP.mes.y}`;
      lineas.push([
        fechaTxt, DIAS_LARGO[f.dw], t.turno.nombre, hor,
        nombreEstado[t.estado]||t.estado, opNom, fmtHoras(t.hs)
      ].join(";"));
    });
  });

  lineas.push("");
  lineas.push(`Total horas simples;${fmtHoras(r.hsSimples)}`);
  lineas.push(`Total horas feriado;${fmtHoras(r.hsFeriado)}`);
  lineas.push(`Total horas;${fmtHoras(r.totalHs)}`);
  lineas.push(`Ausencias;${r.ausencias}`);

  // BOM para que Excel abra bien los acentos, separador ; para locale es-AR
  const csv = "\uFEFF" + lineas.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Planilla_${svc.nombre.replace(/[^a-zA-Z0-9]/g,"_")}_${MESES[APP.mes.m]}_${APP.mes.y}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Descarga un CSV listo para Excel (BOM + separador ; para es-AR)
function descargarCSV(lineas, nombreArchivo){
  const csv = "\uFEFF" + lineas.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// DESCARGA DE FACTURACIÓN DEL MES — todos los servicios juntos
// ============================================================
function descargarFacturacionMes(){
  const svcs = APP.servicios.filter(s => s.estado==="activo")
    .sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
  if(!svcs.length){ alert("No hay servicios para facturar este mes."); return; }

  let lineas = [];
  lineas.push(`Facturación;${MESES[APP.mes.m]} ${APP.mes.y}`);
  lineas.push("");
  lineas.push("Servicio;Razón social;CUIT;Tipo;Hs simples;Hs feriado;Valor hora;Subtotal;IVA;Total");

  let tSimples=0, tFeriado=0, tSubtotal=0, tIva=0, tTotal=0;

  svcs.forEach(svc => {
    const f = calcFacturacion(svc.id, APP.mes.y, APP.mes.m);
    const tipo = f.esFijo ? "Monto fijo" : "Tipo "+f.tipoFactura;
    const vh = f.esFijo ? (facDe(svc.id).montoFijo||0) : f.vh;
    lineas.push([
      svc.nombre,
      svc.razonSocial||"",
      svc.cuit||"",
      tipo,
      f.esFijo ? "" : fmtHoras(f.hsSimples),
      f.esFijo ? "" : fmtHoras(f.hsFeriado),
      Math.round(vh),
      Math.round(f.subtotal),
      Math.round(f.iva),
      Math.round(f.total),
    ].join(";"));
    tSimples += f.hsSimples; tFeriado += f.hsFeriado;
    tSubtotal += f.subtotal; tIva += f.iva; tTotal += f.total;
  });

  lineas.push("");
  lineas.push([
    "TOTALES","","","",
    fmtHoras(tSimples), fmtHoras(tFeriado), "",
    Math.round(tSubtotal), Math.round(tIva), Math.round(tTotal),
  ].join(";"));

  descargarCSV(lineas, `Facturacion_${MESES[APP.mes.m]}_${APP.mes.y}.csv`);
}

// ============================================================
// FICHAR ANOMALÍA — agrega fila en movimientos (hoja 8)
// ============================================================
let FICHAR = null;

function abrirFichar(svcId){
  FICHAR = { svcId: svcId||"", turnoId:"", fecha: hoyISO(), tipo:"ausencia", reemplazoId:"", horarioDistinto:false, entrada:"", salida:"", obs:"" };
  mostrarModalFichar();
}

function mostrarModalFichar(){
  const svcs = serviciosVisibles().sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));
  const svcOpts = svcs.map(s=>`<option value="${s.id}" ${FICHAR.svcId===s.id?"selected":""}>${s.nombre}</option>`).join("");
  const dist = FICHAR.svcId ? distDe(FICHAR.svcId) : {turnos:[]};
  const turnoOpts = (dist.turnos||[]).map(t=>`<option value="${t.id}" ${FICHAR.turnoId===t.id?"selected":""}>${t.nombre} (${t.entrada}-${t.salida})</option>`).join("");
  const opsOpts = APP.operarios.filter(o=>o.estado==="activo").map(o=>`<option value="${o.id}" ${FICHAR.reemplazoId===o.id?"selected":""}>${o.nombreCompleto}</option>`).join("");

  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="cerrarModal();FICHAR=null"></div>
    <div class="modal-box">
      <div class="modal-title">⚠️ Fichar anomalía</div>
      <div class="modal-field"><label>Servicio</label>
        <select onchange="FICHAR.svcId=this.value;FICHAR.turnoId='';mostrarModalFichar()">
          <option value="">— Elegí —</option>${svcOpts}
        </select></div>
      ${FICHAR.svcId?`<div class="modal-field"><label>Turno</label>
        <select onchange="FICHAR.turnoId=this.value;mostrarModalFichar()">
          <option value="">— Elegí el turno —</option>${turnoOpts}
        </select></div>`:""}
      <div class="modal-field"><label>Fecha</label>
        <input type="date" value="${FICHAR.fecha}" onchange="FICHAR.fecha=this.value"></div>
      <div class="modal-field"><label>Tipo</label>
        <select onchange="FICHAR.tipo=this.value;mostrarModalFichar()">
          <option value="ausencia" ${FICHAR.tipo==="ausencia"?"selected":""}>Ausencia (no cubierta)</option>
          <option value="reemplazo" ${FICHAR.tipo==="reemplazo"?"selected":""}>Reemplazo (cubierta)</option>
          <option value="feriado_trabajado" ${FICHAR.tipo==="feriado_trabajado"?"selected":""}>Feriado trabajado</option>
          <option value="cambio_temporal" ${FICHAR.tipo==="cambio_temporal"?"selected":""}>Cambio temporal de horario</option>
        </select></div>
      ${FICHAR.tipo==="reemplazo"?`<div class="modal-field"><label>Operario que cubrió</label>
        <select onchange="FICHAR.reemplazoId=this.value"><option value="">— Elegí —</option>${opsOpts}</select></div>
        <div class="modal-field" style="margin-bottom:6px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" ${FICHAR.horarioDistinto?"checked":""} onchange="FICHAR.horarioDistinto=this.checked;mostrarModalFichar()" style="width:auto">
          El reemplazante hizo otro horario
        </label></div>
        ${FICHAR.horarioDistinto?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="modal-field"><label>Entrada real</label><input type="time" value="${FICHAR.entrada}" onchange="FICHAR.entrada=this.value"></div>
          <div class="modal-field"><label>Salida real</label><input type="time" value="${FICHAR.salida}" onchange="FICHAR.salida=this.value"></div>
        </div>`:""}`:""}
      ${FICHAR.tipo==="cambio_temporal"?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="modal-field"><label>Nueva entrada</label><input type="time" value="${FICHAR.entrada}" onchange="FICHAR.entrada=this.value"></div>
        <div class="modal-field"><label>Nueva salida</label><input type="time" value="${FICHAR.salida}" onchange="FICHAR.salida=this.value"></div>
      </div>`:""}
      <div class="modal-field"><label>Observación (opcional)</label>
        <input type="text" value="${FICHAR.obs}" onchange="FICHAR.obs=this.value" placeholder="Detalle..."></div>
      <div class="modal-actions">
        <button class="btn" onclick="cerrarModal();FICHAR=null">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarFichar()">Fichar</button>
      </div>
    </div>`;
  modal.style.display = "flex";
}

function guardarFichar(){
  const f = FICHAR;
  if(!f.svcId){ alert("Elegí el servicio"); return; }
  if(!f.turnoId){ alert("Elegí el turno"); return; }
  if(!f.fecha){ alert("Elegí la fecha"); return; }
  if(f.tipo==="reemplazo" && !f.reemplazoId){ alert("Elegí quién cubrió"); return; }

  // Determinar entrada/salida según el tipo
  let entrada = "", salida = "";
  if(f.tipo === "cambio_temporal"){
    entrada = f.entrada; salida = f.salida;
  } else if(f.tipo === "reemplazo" && f.horarioDistinto){
    entrada = f.entrada; salida = f.salida;
  }

  APP.movimientos.push({
    id: nuevoId("M"),
    svcId: f.svcId,
    turnoId: f.turnoId,
    fecha: f.fecha,
    tipo: f.tipo,
    reemplazoId: f.reemplazoId||"",
    entrada: entrada,
    salida: salida,
    obs: f.obs||"",
    quien: APP.auth.supervisorId || APP.auth.perfil,
    quienNombre: APP.auth.usuario,
    timestamp: new Date().toISOString(),
  });
  const nuevoMov = APP.movimientos[APP.movimientos.length-1];
  guardarLocal();
  driveAddMovimiento(nuevoMov);
  cerrarModal();
  FICHAR = null;
  render();
}
const TIPO_MOV_LABEL = {
  ausencia:"Ausencia", reemplazo:"Reemplazo",
  feriado_trabajado:"Feriado trabajado", cambio_temporal:"Cambio temporal",
};

// ============================================================
// EDITAR DÍA DE PLANILLA (RRHH) — corrige lo ya fichado
// Crea, reemplaza o borra el movimiento de ese día/turno
// ============================================================
let EDIT_DIA = null;

function editarDiaPlanilla(svcId, turnoId, iso){
  const dist = distDe(svcId);
  const turno = (dist.turnos||[]).find(t => t.id === turnoId);
  if(!turno){ alert("No se encontró el turno"); return; }
  // Buscar si ya hay un movimiento para este día/turno
  const movExistente = APP.movimientos.find(m => m.svcId===svcId && m.turnoId===turnoId && m.fecha===iso);
  const dw = new Date(iso+"T00:00:00").getDay();
  const hd = horarioDia(turno, dw);

  EDIT_DIA = {
    svcId, turnoId, iso,
    turnoNombre: turno.nombre,
    movId: movExistente ? movExistente.id : null,
    // Estado actual: si hay mov usa su tipo, si no "normal"
    tipo: movExistente ? movExistente.tipo : "normal",
    reemplazoId: movExistente ? (movExistente.reemplazoId||"") : "",
    horarioDistinto: movExistente ? !!(movExistente.entrada && movExistente.salida) : false,
    entrada: movExistente && movExistente.entrada ? movExistente.entrada : hd.entrada,
    salida: movExistente && movExistente.salida ? movExistente.salida : hd.salida,
    obs: movExistente ? (movExistente.obs||"") : "",
    horarioBase: hd,
  };
  mostrarModalEditarDia();
}

function mostrarModalEditarDia(){
  const e = EDIT_DIA;
  const fechaTxt = e.iso.split("-").reverse().join("/");
  const opsOpts = APP.operarios.filter(o=>o.estado==="activo")
    .map(o=>`<option value="${o.id}" ${e.reemplazoId===o.id?"selected":""}>${o.nombreCompleto}</option>`).join("");

  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="cerrarModal();EDIT_DIA=null"></div>
    <div class="modal-box">
      <div class="modal-title">✏️ Corregir día — ${fechaTxt}</div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:14px">${e.turnoNombre} · horario base ${e.horarioBase.entrada}-${e.horarioBase.salida}</div>

      <div class="modal-field"><label>Estado del día</label>
        <select onchange="EDIT_DIA.tipo=this.value;mostrarModalEditarDia()">
          <option value="normal" ${e.tipo==="normal"?"selected":""}>Normal (trabajado)</option>
          <option value="ausencia" ${e.tipo==="ausencia"?"selected":""}>Ausencia</option>
          <option value="reemplazo" ${e.tipo==="reemplazo"?"selected":""}>Reemplazo</option>
          <option value="feriado_trabajado" ${e.tipo==="feriado_trabajado"?"selected":""}>Feriado trabajado</option>
          <option value="cambio_temporal" ${e.tipo==="cambio_temporal"?"selected":""}>Cambio de horario</option>
        </select></div>

      ${e.tipo==="reemplazo"?`<div class="modal-field"><label>Operario que cubrió</label>
        <select onchange="EDIT_DIA.reemplazoId=this.value"><option value="">— Elegí —</option>${opsOpts}</select></div>
        <div class="modal-field" style="margin-bottom:6px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" ${e.horarioDistinto?"checked":""} onchange="EDIT_DIA.horarioDistinto=this.checked;mostrarModalEditarDia()" style="width:auto">
          Hizo otro horario</label></div>
        ${e.horarioDistinto?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="modal-field"><label>Entrada real</label><input type="time" value="${e.entrada}" onchange="EDIT_DIA.entrada=this.value"></div>
          <div class="modal-field"><label>Salida real</label><input type="time" value="${e.salida}" onchange="EDIT_DIA.salida=this.value"></div>
        </div>`:""}`:""}

      ${e.tipo==="cambio_temporal"?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="modal-field"><label>Nueva entrada</label><input type="time" value="${e.entrada}" onchange="EDIT_DIA.entrada=this.value"></div>
        <div class="modal-field"><label>Nueva salida</label><input type="time" value="${e.salida}" onchange="EDIT_DIA.salida=this.value"></div>
      </div>`:""}

      <div class="modal-field"><label>Observación (opcional)</label>
        <input type="text" value="${e.obs}" onchange="EDIT_DIA.obs=this.value" placeholder="Detalle..."></div>

      <div class="modal-actions">
        <button class="btn" onclick="cerrarModal();EDIT_DIA=null">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarEdicionDia()">Guardar</button>
      </div>
    </div>`;
  modal.style.display = "flex";
}

function guardarEdicionDia(){
  const e = EDIT_DIA;
  if(e.tipo==="reemplazo" && !e.reemplazoId){ alert("Elegí quién cubrió"); return; }

  // Si había un movimiento previo, lo quitamos (lo vamos a reemplazar o dejar en normal)
  if(e.movId){
    APP.movimientos = APP.movimientos.filter(m => m.id !== e.movId);
    driveDeleteMovimiento(e.movId);
  }

  // Si el nuevo estado es "normal", con haber borrado el movimiento alcanza
  if(e.tipo !== "normal"){
    let entrada = "", salida = "";
    if(e.tipo==="cambio_temporal"){ entrada=e.entrada; salida=e.salida; }
    else if(e.tipo==="reemplazo" && e.horarioDistinto){ entrada=e.entrada; salida=e.salida; }

    const mov = {
      id: nuevoId("M"),
      svcId: e.svcId, turnoId: e.turnoId, fecha: e.iso, tipo: e.tipo,
      reemplazoId: e.reemplazoId||"", entrada, salida, obs: e.obs||"",
      quien: APP.auth.supervisorId || APP.auth.perfil,
      quienNombre: APP.auth.usuario,
      timestamp: new Date().toISOString(),
    };
    APP.movimientos.push(mov);
    driveAddMovimiento(mov);
  }

  guardarLocal();
  cerrarModal();
  EDIT_DIA = null;
  render();
}

function renderMovimientos(){
  const pref = isoFecha(APP.mes.y, APP.mes.m, 1).slice(0,7);
  let movs = APP.movimientos.filter(m => (m.fecha||"").startsWith(pref));
  movs = movs.sort((a,b) => (b.fecha||"").localeCompare(a.fecha||"") || (b.timestamp||"").localeCompare(a.timestamp||""));

  const nombreSvc = id => { const s=APP.servicios.find(x=>x.id===id); return s?s.nombre:id; };
  const nombreTurno = (svcId,tId) => { const d=distDe(svcId); const t=(d.turnos||[]).find(x=>x.id===tId); return t?t.nombre:"—"; };

  const filas = movs.map(m => `<tr>
    <td style="padding:9px 12px;font-family:monospace;font-size:11px">${(m.fecha||"").split("-").reverse().join("/")}</td>
    <td style="padding:9px 12px;font-size:12px"><strong>${nombreSvc(m.svcId)}</strong><br><span style="font-size:10px;color:var(--text3)">${nombreTurno(m.svcId,m.turnoId)}</span></td>
    <td style="padding:9px 12px"><span style="font-size:11px">${TIPO_MOV_LABEL[m.tipo]||m.tipo}</span></td>
    <td style="padding:9px 12px;font-size:11px;color:var(--text2)">${m.quienNombre||m.quien||"—"}</td>
    <td style="padding:9px 12px;font-size:10px;color:var(--text3)">${m.timestamp?new Date(m.timestamp).toLocaleString("es-AR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):""}</td>
    <td style="padding:9px 12px;font-size:11px;color:var(--text2)">${m.obs||""}</td>
  </tr>`).join("");

  // Resumen por supervisor (reporte)
  const porSup = {};
  movs.forEach(m => { const k=m.quienNombre||m.quien||"—"; porSup[k]=(porSup[k]||0)+1; });
  const chips = Object.entries(porSup).map(([k,v])=>`<span style="display:inline-block;background:var(--primary-bg);color:var(--primary);border-radius:20px;padding:4px 12px;font-size:12px;margin:3px">${k}: ${v}</span>`).join("");

  const navMes = `<div style="display:flex;align-items:center;gap:10px">
    <button class="btn btn-sm" onclick="cambiarMes(-1)">‹</button>
    <span style="font-size:14px;font-weight:500;min-width:120px;text-align:center">${MESES[APP.mes.m]} ${APP.mes.y}</span>
    <button class="btn btn-sm" onclick="cambiarMes(1)">›</button>
  </div>`;

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">${navMes}
      <span style="font-size:12px;color:var(--text3)">${movs.length} movimiento(s)</span></div>
    ${chips?`<div class="card" style="padding:14px 18px"><div style="font-size:11px;color:var(--text3);text-transform:uppercase;margin-bottom:8px">Cargas por persona</div>${chips}</div>`:""}
    <div class="card"><div class="card-header"><h3>Movimientos de ${MESES[APP.mes.m]} ${APP.mes.y}</h3></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Fecha</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Servicio</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Tipo</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Fichó</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Cuándo</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Obs</th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">No hay movimientos este mes.</td></tr>`}</tbody>
    </table></div></div>`;
}
// ============================================================
// FACTURACIÓN — cruza planilla del mes con valores (hoja 2)
// Tipo A: subtotal + IVA 21% sobre subtotal
// Tipo B: IVA incluido en el valor hora
// Monto fijo: total fijo + IVA
// Feriados: horas dobles (ya vienen dobladas de la planilla)
// ============================================================
function calcFacturacion(svcId, y, m){
  const fac = facDe(svcId);
  const res = resumenPlanilla(svcId, y, m);
  const tipoContrato = fac.tipoContrato || "horas";
  const tipoFactura = fac.tipoFactura || "A";
  const vh = fac.valorHora || 0;

  // hsSimples y hsFeriado son horas REALES. El doble de feriado va en el importe.
  const totalHs = res.hsSimples + res.hsFeriado;

  let subtotal, iva, total, vhMostrar;

  if(tipoContrato === "fijo"){
    const mf = fac.montoFijo || 0;
    subtotal = mf;
    iva = mf * 0.21;
    total = mf + iva;
    vhMostrar = 0;
  } else if(tipoFactura === "A"){
    // Tipo A: horas simples a vh, horas feriado a vh x2
    const vhR = Math.round(vh);
    subtotal = vhR * res.hsSimples + vhR * 2 * res.hsFeriado;
    iva = subtotal * 0.21;
    total = Math.round(subtotal + iva);
    subtotal = Math.round(subtotal);
    iva = Math.round(iva);
    vhMostrar = vhR;
  } else {
    // Tipo B: vh con IVA incluido. Horas simples a vhConIva, feriado x2
    const vhSinIva = Math.round(vh);
    const vhConIva = vhSinIva * 1.21;
    total = Math.round(vhConIva * res.hsSimples + vhConIva * 2 * res.hsFeriado);
    subtotal = Math.round(vhSinIva * res.hsSimples + vhSinIva * 2 * res.hsFeriado);
    iva = total - subtotal;
    vhMostrar = Math.round(vhConIva);
  }

  return {
    hsSimples: res.hsSimples, hsFeriado: res.hsFeriado, totalHs,
    ausencias: res.ausencias, vh: vhMostrar, subtotal, iva, total,
    tipoContrato, tipoFactura, esFijo: tipoContrato==="fijo",
  };
}

function fmtMoneda(n){ return "$" + Math.round(n).toLocaleString("es-AR"); }
// Muestra horas con media si aplica: 4 → "4", 4.5 → "4.5"
function fmtHoras(n){
  if(!n) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function renderPrefac(){
  const svcs = APP.servicios.filter(s => {
    if(s.estado !== "activo") return true; // incluir bajas del mes
    return true;
  }).filter(s => s.estado==="activo").sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"));

  const navMes = `<div style="display:flex;align-items:center;gap:10px">
    <button class="btn btn-sm" onclick="cambiarMes(-1)">‹</button>
    <span style="font-size:14px;font-weight:500;min-width:120px;text-align:center">${MESES[APP.mes.m]} ${APP.mes.y}</span>
    <button class="btn btn-sm" onclick="cambiarMes(1)">›</button>
  </div>`;

  const rows = svcs.map(s => ({ svc:s, f: calcFacturacion(s.id, APP.mes.y, APP.mes.m) }));
  const totalGeneral = rows.reduce((a,r) => a + r.f.total, 0);
  const totalHs = rows.reduce((a,r) => a + r.f.totalHs, 0);
  const totalSimples = rows.reduce((a,r) => a + r.f.hsSimples, 0);
  const totalFeriado = rows.reduce((a,r) => a + r.f.hsFeriado, 0);

  const filas = rows.map(({svc,f}) => `<tr>
    <td style="padding:9px 12px"><strong>${svc.nombre}</strong><br>
      <span style="font-size:10px;color:var(--text3)">${f.esFijo?"Monto fijo":"Tipo "+f.tipoFactura}${svc.cuit?" · "+svc.cuit:""}</span></td>
    <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:12px">${f.esFijo?"—":fmtHoras(f.hsSimples)}</td>
    <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:12px">${f.esFijo?"—":fmtHoras(f.hsFeriado)}</td>
    <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:12px">${f.esFijo?fmtMoneda(facDe(svc.id).montoFijo||0):fmtMoneda(f.vh)}</td>
    <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:12px">${fmtMoneda(f.subtotal)}</td>
    <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:12px;color:var(--text2)">${fmtMoneda(f.iva)}</td>
    <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:13px;font-weight:600">${fmtMoneda(f.total)}</td>
    <td style="padding:9px 12px;text-align:center"><button class="btn btn-sm" onclick="descargarPlanillaServicio('${svc.id}')" title="Descargar planilla">⬇️</button></td>
  </tr>`).join("");

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">${navMes}
      <div style="display:flex;gap:20px;align-items:center">
        <div style="text-align:right"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs simples</div>
          <div style="font-size:16px;font-weight:600">${fmtHoras(totalSimples)}</div></div>
        <div style="text-align:right"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs feriado</div>
          <div style="font-size:16px;font-weight:600">${fmtHoras(totalFeriado)}</div></div>
        <div style="text-align:right"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Hs totales</div>
          <div style="font-size:16px;font-weight:600">${fmtHoras(totalHs)}</div></div>
        <div style="text-align:right;padding-left:16px;border-left:1px solid var(--border)"><div style="font-size:10px;color:var(--text3);text-transform:uppercase">Total del mes</div>
          <div style="font-size:20px;font-weight:600;color:var(--primary)">${fmtMoneda(totalGeneral)}</div></div>
      </div>
    </div>
    <div class="card"><div class="card-header"><h3>Prefacturación — ${MESES[APP.mes.m]} ${APP.mes.y}</h3>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:11px;color:var(--text3)">${svcs.length} servicio(s) · ${fmtHoras(totalHs)} hs efectivas</span>
        <button class="btn btn-sm btn-primary" onclick="descargarFacturacionMes()">⬇️ Descargar facturación del mes</button>
      </div></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Servicio</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Hs simples</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Hs feriado</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Valor hora</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Subtotal</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">IVA</th>
        <th style="text-align:right;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Total</th>
        <th style="padding:8px 12px"></th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text3)">No hay servicios.</td></tr>`}</tbody>
      <tfoot><tr style="background:var(--surface2);border-top:1px solid var(--border)">
        <td style="padding:10px 12px;font-weight:600">TOTAL</td>
        <td colspan="5"></td>
        <td style="padding:10px 12px;text-align:right;font-family:monospace;font-weight:600;font-size:14px">${fmtMoneda(totalGeneral)}</td>
        <td></td>
      </tr></tfoot>
    </table></div></div>
    <div class="hint-box" style="background:var(--blue-bg);border:0.5px solid rgba(24,119,242,0.2);border-radius:var(--radius);padding:10px 12px;font-size:11px;color:var(--text2)">
      ℹ️ <strong>Tipo A:</strong> subtotal + 21% IVA · <strong>Tipo B:</strong> IVA incluido en el valor hora · Feriados trabajados cuentan doble.
    </div>`;
}

// ============================================================
// RECLAMOS DE FACTURACIÓN
// ============================================================
const ESTADO_RECLAMO = {
  abierto:   { txt:"Abierto",   bg:"var(--amber-bg)", fg:"var(--amber-txt)" },
  en_proceso:{ txt:"En proceso",bg:"var(--blue-bg)",  fg:"var(--blue-txt)" },
  resuelto:  { txt:"Resuelto",  bg:"var(--green-bg)", fg:"var(--green-txt)" },
};

function renderReclamos(){
  const reclamos = (APP.reclamos||[]).slice().sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));
  const nombreSvc = id => { const s=APP.servicios.find(x=>x.id===id); return s?s.nombre:"—"; };

  const filas = reclamos.map(r => {
    const e = ESTADO_RECLAMO[r.estado] || ESTADO_RECLAMO.abierto;
    return `<tr>
      <td style="padding:9px 12px;font-family:monospace;font-size:11px">${(r.fecha||"").split("-").reverse().join("/")}</td>
      <td style="padding:9px 12px;font-size:12px"><strong>${nombreSvc(r.svcId)}</strong></td>
      <td style="padding:9px 12px;font-size:12px">${r.motivo||""}</td>
      <td style="padding:9px 12px;font-size:11px;color:var(--text2);max-width:280px">${r.detalle||""}</td>
      <td style="padding:9px 12px"><span style="background:${e.bg};color:${e.fg};font-size:11px;padding:2px 8px;border-radius:20px">${e.txt}</span></td>
      <td style="padding:9px 12px;white-space:nowrap">
        <button class="btn btn-sm" onclick="editarReclamo('${r.id}')">Editar</button>
        <button class="btn btn-sm" onclick="eliminarReclamo('${r.id}')" style="color:var(--red-txt)">Borrar</button>
      </td>
    </tr>`;
  }).join("");

  const abiertos = reclamos.filter(r => r.estado !== "resuelto").length;

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:12px;color:var(--text2)">${reclamos.length} reclamo(s) · ${abiertos} sin resolver</div>
      <button class="btn btn-primary" onclick="nuevoReclamo()">+ Nuevo reclamo</button>
    </div>
    <div class="card"><div class="card-header"><h3>Reclamos de facturación</h3></div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:var(--surface2)">
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Fecha</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Servicio</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Motivo</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Detalle</th>
        <th style="text-align:left;padding:8px 12px;font-size:10px;color:var(--text3);text-transform:uppercase">Estado</th>
        <th style="padding:8px 12px"></th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text3)">No hay reclamos cargados.</td></tr>`}</tbody>
    </table></div></div>`;
}

function nuevoReclamo(){ abrirModalReclamo(null); }
function editarReclamo(id){ abrirModalReclamo(id); }

function abrirModalReclamo(id){
  const r = id ? APP.reclamos.find(x => x.id === id) : null;
  const svcsOpts = APP.servicios.filter(s=>s.estado==="activo")
    .sort((a,b)=>a.nombre.localeCompare(b.nombre,"es"))
    .map(s=>`<option value="${s.id}" ${r&&r.svcId===s.id?"selected":""}>${s.nombre}</option>`).join("");

  const modal = document.getElementById("modal");
  modal.innerHTML = `
    <div class="modal-backdrop" onclick="cerrarModal()"></div>
    <div class="modal-box">
      <div class="modal-title">${r?"Editar":"Nuevo"} reclamo</div>
      <div class="modal-field"><label>Servicio</label>
        <select id="rec-svc"><option value="">— Elegí —</option>${svcsOpts}</select></div>
      <div class="modal-field"><label>Fecha</label>
        <input id="rec-fecha" type="date" value="${r?r.fecha:hoyISO()}"></div>
      <div class="modal-field"><label>Motivo</label>
        <input id="rec-motivo" type="text" value="${r?(r.motivo||''):''}" placeholder="Ej: Exceso de horas facturadas"></div>
      <div class="modal-field"><label>Detalle</label>
        <textarea id="rec-detalle" rows="3" style="width:100%;padding:9px 12px;border:1px solid var(--border2);border-radius:var(--radius);font-size:13px;font-family:inherit;resize:vertical" placeholder="Descripción del reclamo...">${r?(r.detalle||''):''}</textarea></div>
      <div class="modal-field"><label>Estado</label>
        <select id="rec-estado">
          <option value="abierto" ${r&&r.estado==="abierto"?"selected":""}>Abierto</option>
          <option value="en_proceso" ${r&&r.estado==="en_proceso"?"selected":""}>En proceso</option>
          <option value="resuelto" ${r&&r.estado==="resuelto"?"selected":""}>Resuelto</option>
        </select></div>
      <div class="modal-actions">
        <button class="btn" onclick="cerrarModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarReclamo('${id||''}')">${r?"Guardar":"Crear"}</button>
      </div>
    </div>`;
  modal.style.display = "flex";
}

function guardarReclamo(id){
  const svcId  = document.getElementById("rec-svc").value;
  const fecha  = document.getElementById("rec-fecha").value;
  const motivo = document.getElementById("rec-motivo").value.trim();
  const detalle= document.getElementById("rec-detalle").value.trim();
  const estado = document.getElementById("rec-estado").value;
  if(!svcId){ alert("Elegí el servicio"); return; }
  if(!motivo){ alert("Ingresá el motivo"); return; }

  let recId = id;
  if(id){
    APP.reclamos = APP.reclamos.map(r => r.id===id ? {...r, svcId, fecha, motivo, detalle, estado} : r);
  } else {
    recId = nuevoId("R");
    APP.reclamos.push({
      id: recId, svcId, fecha, motivo, detalle, estado,
      quien: APP.auth.usuario, timestamp: new Date().toISOString(),
    });
  }
  guardarLocal();
  driveSaveReclamo(recId);
  cerrarModal();
  render();
}

function eliminarReclamo(id){
  const r = APP.reclamos.find(x => x.id === id);
  if(!r) return;
  if(!confirm("¿Borrar este reclamo?")) return;
  APP.reclamos = APP.reclamos.filter(x => x.id !== id);
  guardarLocal();
  driveDeleteReclamo(id);
  render();
}

function renderConfig(){
  return `
    <div class="card"><div class="card-header"><h3>📥 Importar servicios desde backup</h3></div>
    <div style="padding:18px">
      <p style="font-size:12px;color:var(--text2);margin-bottom:14px">
        Cargá el archivo <strong>CleanIt_Backup_*.json</strong> para importar todos los servicios, operarios y su distribución de una sola vez, adaptados a la estructura nueva.
      </p>
      <div class="hint-box" style="background:var(--amber-bg);border:0.5px solid var(--amber-txt);color:var(--amber-txt);border-radius:var(--radius);padding:10px 12px;font-size:12px;margin-bottom:14px">
        ⚠️ Esto <strong>reemplaza todo</strong> lo que tengas cargado (servicios, operarios, distribución). Los movimientos no se tocan. Usalo una sola vez para la carga inicial.
      </div>
      <input type="file" id="import-file" accept=".json" style="margin-bottom:12px;font-size:13px">
      <br>
      <button class="btn btn-primary" onclick="importarBackup()">Importar backup</button>
      <div id="import-status" style="margin-top:12px;font-size:12px;color:var(--text2)"></div>
    </div></div>

    <div class="card"><div class="card-header"><h3>🔐 Contraseñas de supervisores</h3></div>
    <div style="padding:18px">
      <p style="font-size:12px;color:var(--text2);margin-bottom:14px">Cambiá la contraseña de cada supervisor o jefe.</p>
      ${APP.supervisores.filter(s=>s.estado==="activo").map(s=>`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:center;padding:8px 0;border-bottom:0.5px solid var(--border)">
          <div style="font-size:13px"><strong>${s.nombreCompleto}</strong> <span style="font-size:10px;color:var(--text3)">${s.id}</span></div>
          <div style="display:flex;gap:6px">
            <input type="text" id="clave-${s.id}" value="${s.clave||'super2024'}" style="flex:1;padding:6px 10px;border:1px solid var(--border2);border-radius:var(--radius);font-size:12px">
            <button class="btn btn-sm" onclick="cambiarClaveSup('${s.id}')">Guardar</button>
          </div>
        </div>`).join("") || '<span style="color:var(--text3);font-size:12px">No hay supervisores cargados.</span>'}
    </div></div>`;
}

function cambiarClaveSup(id){
  const val = document.getElementById("clave-"+id).value.trim();
  if(val.length < 6){ alert("La contraseña debe tener al menos 6 caracteres"); return; }
  APP.supervisores = APP.supervisores.map(s => s.id===id ? {...s, clave:val} : s);
  guardarLocal();
  driveSaveSupervisor(id);
  alert("✅ Contraseña actualizada");
}

async function importarBackup(){
  const input = document.getElementById("import-file");
  const status = document.getElementById("import-status");
  if(!input.files.length){ alert("Elegí el archivo de backup"); return; }
  if(!confirm("Esto reemplaza todos los servicios, operarios y distribución actuales. ¿Continuar?")) return;

  try{
    const texto = await input.files[0].text();
    const bk = JSON.parse(texto);
    const svcsBk = (bk.servicios||[]).filter(s => s.activo);
    const opsBk  = (bk.operarios||[]).filter(o => o.activo);

    status.textContent = "Procesando...";

    // 1. Operarios → hoja 3 con IDs nuevos. Mapa nombreCompleto → nuevoId
    APP.operarios = [];
    APP.contadores.O = 0;
    const mapaOpNombre = {}; // nombre corto o completo → id nuevo
    opsBk.forEach(o => {
      const id = nuevoIdSilencioso("O");
      APP.operarios.push({ id, nombreCompleto: o.nombreCompleto||o.nombre, jornada: o.jornada||"reducida", estado:"activo" });
      if(o.nombre) mapaOpNombre[o.nombre.trim().toUpperCase()] = id;
      if(o.nombreCompleto) mapaOpNombre[o.nombreCompleto.trim().toUpperCase()] = id;
    });

    // 2. Servicios → hojas 1, 2, 5
    APP.servicios = [];
    APP.facturacion = [];
    APP.distribucion = [];
    APP.contadores.S = 0;

    svcsBk.forEach(s => {
      const svcId = nuevoIdSilencioso("S");
      // Hoja 1
      APP.servicios.push({
        id: svcId, nombre: s.nombre||"", tipo: s.tipo||"Consorcio",
        cuit: s.cuit||"", mail: s.mail||"", razonSocial: s.razonSocial||"",
        supervisorId: "", // los supervisores se reasignan a mano (nombres viejos)
        estado: "activo", fechaBaja:"", motivoBaja:"",
      });
      // Hoja 2
      APP.facturacion.push({
        svcId, valorHora: s.valorHora||0, tipoFactura: s.tipoFactura||"A",
        tipoContrato: s.tipoContrato||"horas", montoFijo: s.montoFijo||0,
      });
      // Hoja 5 — turnos
      let turnos = [];
      if(s.turnos && s.turnos.length){
        turnos = s.turnos.map(t => ({
          id: "T"+svcId+"_"+Math.random().toString(36).slice(2,7),
          nombre: t.nombre||"Turno",
          frecuencia: "semanal",
          dias: t.dias||[1,2,3,4,5],
          entrada: t.entrada||"08:00",
          salida: t.salida||"12:00",
          horarioPorDia: t.horarioPorDia||{},
          operarioId: mapaOpNombre[(t.operario||"").trim().toUpperCase()] || "",
        }));
      } else {
        // Servicio sin turnos → armar uno con los datos base
        turnos = [{
          id: "T"+svcId+"_0",
          nombre: "Turno único",
          frecuencia: "semanal",
          dias: s.dias||[1,2,3,4,5],
          entrada: s.entrada||"08:00",
          salida: s.salida||"12:00",
          operarioId: mapaOpNombre[(s.operario||"").trim().toUpperCase()] || "",
        }];
      }
      APP.distribucion.push({ svcId, turnos });
    });

    guardarLocal();
    status.textContent = `✅ Importados: ${APP.servicios.length} servicios, ${APP.operarios.length} operarios. Subiendo a Drive...`;

    // 3. Subir todo a Drive uno por uno
    let ok=0, fail=0;
    for(const o of APP.operarios){
      try{ await driveSaveOperario(o.id); ok++; }catch(e){ fail++; }
    }
    for(const s of APP.servicios){
      try{ await driveSaveServicio(s.id); ok++; }catch(e){ fail++; }
    }
    status.textContent = `✅ Importación completa. ${APP.servicios.length} servicios y ${APP.operarios.length} operarios cargados y subidos a Drive.`;
    setTimeout(()=>render(), 1500);

  }catch(e){
    status.textContent = "❌ Error: " + e.message;
    console.error(e);
  }
}

// Genera ID sin guardar en cada paso (para bucles de importación)
function nuevoIdSilencioso(pref){
  APP.contadores[pref] = (APP.contadores[pref]||0) + 1;
  const n = String(APP.contadores[pref]).padStart(pref==="M"?4:3, "0");
  return pref + n;
}

function renderLogin(){
  const supsLogin = APP.supervisores
    .filter(s => s.estado === "activo")
    .map(s => `<option value="${s.id}">${s.nombreCompleto}${s.cargo==="jefe"?" (Jefe)":""}</option>`)
    .join("");
  const fijos = Object.entries(USUARIOS_LOGIN)
    .map(([k,u]) => `<option value="${k}">${u.nombre}</option>`)
    .join("");
  return `<div class="login-wrap"><div class="login-box">
    <div class="login-logo">
      <svg width="56" height="56" viewBox="0 0 100 120" fill="none" style="margin-bottom:12px">
        <path d="M50 0 C50 0 8 42 8 72 C8 94 27 112 50 112 C73 112 92 94 92 72 C92 42 50 0 50 0Z" fill="#1877F2"/>
      </svg>
      <div style="font-size:22px;font-weight:600;color:var(--text)">Clean it</div>
      <div style="font-size:12px;color:var(--text3);margin-top:4px">Gestión de servicios</div>
    </div>
    <div class="login-field">
      <label>¿Quién sos?</label>
      <select id="login-usuario">
        ${fijos}
        ${supsLogin}
      </select>
    </div>
    <div class="login-field">
      <label>Contraseña</label>
      <input id="login-clave" type="password" placeholder="Ingresá tu contraseña"
        onkeydown="if(event.key==='Enter')intentarLogin()">
    </div>
    <div class="login-error" id="login-error"></div>
    <button onclick="intentarLogin()" class="btn btn-primary" style="width:100%;justify-content:center;padding:11px">Ingresar</button>
  </div></div>`;
}

// ============================================================
// RENDER PRINCIPAL
// ============================================================
const RENDERERS = {
  servicios: renderServicios,
  "form-svc": renderFormSvc,
  operarios: renderOperarios,
  "planilla-op": renderPlanillaOperario,
  personal: renderPersonal,
  distribucion: renderDistribucion,
  control: renderControl,
  movimientos: renderMovimientos,
  prefac: renderPrefac,
  reclamos: renderReclamos,
  config: renderConfig,
};

function render(){
  const sidebar = document.getElementById("sidebar");
  const topbar  = document.getElementById("topbar");
  const content = document.getElementById("content");
  if(!content) return;

  // Sin sesión → login
  if(!APP.auth.perfil){
    sidebar.style.display = "none";
    topbar.style.display = "none";
    content.style.cssText = "position:fixed;inset:0;z-index:500;padding:0;margin:0;background:var(--bg)";
    content.innerHTML = renderLogin();
    return;
  }

  sidebar.style.display = "";
  topbar.style.display = "";
  content.style.cssText = "";

  // Si la pantalla actual no está permitida, ir a la primera permitida
  // (form-svc es sub-pantalla de servicios)
  const subPantallas = { "form-svc":"servicios", "planilla-op":"operarios" };
  const screenBase = subPantallas[APP.screen] || APP.screen;
  if(!puedeVer(screenBase)){
    const primera = PERMISOS[APP.auth.perfil].screens[0];
    APP.screen = primera;
  }

  renderNav();

  // Perfil en sidebar
  const perfilEl = document.getElementById("sidebar-perfil");
  if(perfilEl) perfilEl.textContent = APP.auth.usuario || "Clean it";

  // Topbar
  const tituloBase = subPantallas[APP.screen] ? SCREENS[subPantallas[APP.screen]].titulo : (SCREENS[APP.screen]?.titulo || "");
  document.getElementById("topbar-title").textContent = tituloBase;
  document.getElementById("topbar-meta").textContent = `${MESES[APP.mes.m]} ${APP.mes.y}`;

  // Contenido
  const renderer = RENDERERS[APP.screen] || renderServicios;
  content.innerHTML = renderer();
}

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// ============================================================
// FERIADOS ARGENTINA 2026-2027
// ============================================================
const FERIADOS = {
  "2026-01-01":"Año Nuevo","2026-02-16":"Carnaval","2026-02-17":"Carnaval",
  "2026-03-24":"Memoria","2026-04-02":"Malvinas","2026-04-03":"Viernes Santo",
  "2026-05-01":"Trabajador","2026-05-25":"Revolución de Mayo","2026-06-15":"Güemes",
  "2026-06-20":"Belgrano","2026-07-09":"Independencia","2026-08-17":"San Martín",
  "2026-10-12":"Diversidad","2026-11-23":"Soberanía","2026-12-08":"Inmaculada","2026-12-25":"Navidad",
  "2027-01-01":"Año Nuevo","2027-02-15":"Carnaval","2027-02-16":"Carnaval",
  "2027-03-24":"Memoria","2027-03-26":"Viernes Santo","2027-04-02":"Malvinas",
  "2027-05-01":"Trabajador","2027-05-25":"Revolución de Mayo","2027-06-15":"Güemes",
  "2027-06-21":"Belgrano","2027-07-09":"Independencia","2027-08-16":"San Martín",
  "2027-10-11":"Diversidad","2027-11-22":"Soberanía","2027-12-08":"Inmaculada","2027-12-25":"Navidad",
};

function isoFecha(y,m,d){ return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }
function esFeriado(iso){ return FERIADOS[iso] || null; }
function hoyISO(){ const d=new Date(); return isoFecha(d.getFullYear(),d.getMonth(),d.getDate()); }
function diasDelMes(y,m){
  const total = new Date(y,m+1,0).getDate();
  const out = [];
  for(let d=1; d<=total; d++){
    const fecha = new Date(y,m,d);
    out.push({ d, dw: fecha.getDay(), iso: isoFecha(y,m,d) });
  }
  return out;
}
function hsEntreHorarios(entrada, salida){
  if(!entrada || !salida) return 0;
  const [h1,m1] = entrada.split(":").map(Number);
  const [h2,m2] = salida.split(":").map(Number);
  return Math.max(0, (h2*60+m2 - (h1*60+m1)) / 60);
}

// ============================================================
// ARRANQUE
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  cargarLocal();       // primero lo local (rápido)
  restaurarSesion();
  render();
  // Después intentar traer lo último de Drive
  if(driveActivo()){
    const ok = await cargarDeDrive();
    if(ok) render();
  }
});
