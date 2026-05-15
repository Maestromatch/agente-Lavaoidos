// lib/sheets.js
// Capa de acceso a Google Sheets. Cada hoja modela una "tabla".
// Hojas requeridas: Operativos, Conversaciones, Reservas, Recordatorios.

import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

let _doc = null;

async function getDoc() {
  if (_doc) return _doc;

  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  _doc = doc;
  return doc;
}

export async function getSheet(name) {
  const doc = await getDoc();
  const sheet = doc.sheetsByTitle[name];
  if (!sheet) throw new Error(`Hoja "${name}" no existe en el spreadsheet`);
  return sheet;
}

// ── Operativos ────────────────────────────────────────────────────────────────

export async function getOperativosDisponibles() {
  const sheet = await getSheet("Operativos");
  const rows = await sheet.getRows();
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  return rows
    .filter((r) => {
      const fecha = new Date(r.get("fecha"));
      const cupos = Number(r.get("cupos_disponibles"));
      const activo = String(r.get("activo")).toLowerCase() === "true";
      return fecha >= hoy && cupos > 0 && activo;
    })
    .map((r) => ({
      id: r.get("id"),
      lugar: r.get("lugar"),
      fecha: r.get("fecha"),
      hora: r.get("hora"),
      direccion: r.get("direccion"),
      precio: Number(r.get("precio")),
      cupos_disponibles: Number(r.get("cupos_disponibles")),
    }));
}

export async function descontarCupo(operativoId) {
  const sheet = await getSheet("Operativos");
  const rows = await sheet.getRows();
  const op = rows.find((r) => r.get("id") === operativoId);
  if (!op) return;

  const cupos = Number(op.get("cupos_disponibles"));
  if (cupos > 0) {
    op.set("cupos_disponibles", cupos - 1);
    await op.save();
  }
}

// ── Conversaciones ────────────────────────────────────────────────────────────

export async function getConversacion(phone) {
  const sheet = await getSheet("Conversaciones");
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get("phone") === phone);

  if (!row) return { history: [], step: "inicio", row: null };

  let history = [];
  try {
    history = JSON.parse(row.get("history") || "[]");
  } catch {
    history = [];
  }

  return {
    history,
    step: row.get("step") || "inicio",
    row,
  };
}

export async function saveConversacion(phone, { history, step }, existingRow) {
  // Limitar historial a últimos 20 mensajes para no inflar el sheet
  const trimmed = history.length > 20 ? history.slice(-20) : history;
  const now = new Date().toISOString();

  if (existingRow) {
    existingRow.set("history", JSON.stringify(trimmed));
    existingRow.set("step", step);
    existingRow.set("ultimo_mensaje", now);
    await existingRow.save();
    return;
  }

  const sheet = await getSheet("Conversaciones");
  await sheet.addRow({
    phone,
    history: JSON.stringify(trimmed),
    step,
    ultimo_mensaje: now,
  });
}

// ── Reservas ──────────────────────────────────────────────────────────────────

export async function crearReserva(data) {
  const sheet = await getSheet("Reservas");
  await sheet.addRow({
    id: data.id,
    phone: data.phone,
    nombre: data.nombre,
    rut: data.rut,
    operativo_id: data.operativo_id,
    operativo_lugar: data.operativo_lugar,
    operativo_fecha: data.operativo_fecha,
    operativo_hora: data.operativo_hora,
    operativo_direccion: data.operativo_direccion,
    precio: data.precio,
    estado: "pendiente_pago",
    link_pago: data.link_pago,
    creado_en: new Date().toISOString(),
  });
}

export async function confirmarReserva(reservaId, paymentId) {
  const sheet = await getSheet("Reservas");
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get("id") === reservaId);

  if (!row || row.get("estado") === "confirmada") return null;

  row.set("estado", "confirmada");
  row.set("payment_id", String(paymentId));
  row.set("confirmado_en", new Date().toISOString());
  await row.save();

  return {
    phone: row.get("phone"),
    nombre: row.get("nombre"),
    rut: row.get("rut"),
    operativo_id: row.get("operativo_id"),
    operativo_fecha: row.get("operativo_fecha"),
    operativo_hora: row.get("operativo_hora"),
    operativo_lugar: row.get("operativo_lugar"),
    operativo_direccion: row.get("operativo_direccion"),
  };
}

// ── Recordatorios ─────────────────────────────────────────────────────────────

export async function agendarRecordatorios({ phone, nombre, fecha, hora, lugar, direccion }) {
  const [y, m, d] = fecha.split("-").map(Number);
  const [hh, mm] = hora.split(":").map(Number);
  const operativoDate = new Date(y, m - 1, d, hh, mm);

  const r48h = new Date(operativoDate.getTime() - 48 * 60 * 60 * 1000);
  const r2h = new Date(operativoDate.getTime() - 2 * 60 * 60 * 1000);

  const sheet = await getSheet("Recordatorios");
  const base = { phone, nombre, fecha, hora, lugar, direccion, enviado: "false" };

  await sheet.addRow({
    ...base,
    tipo: "48h",
    enviar_en: r48h.toISOString(),
    mensaje: buildReminderText("48h", { nombre, fecha, hora, lugar, direccion }),
  });

  await sheet.addRow({
    ...base,
    tipo: "2h",
    enviar_en: r2h.toISOString(),
    mensaje: buildReminderText("2h", { nombre, fecha, hora, lugar, direccion }),
  });
}

// ── Objeciones (motivos de no-reserva) ───────────────────────────────────────
// Cuando una conversación queda inactiva sin cierre, el agente pregunta qué
// frenó al lead. La respuesta se categoriza y guarda acá para reporting.

export async function registrarObjecion({ phone, categoria, texto_original, paso_en_que_quedo }) {
  try {
    const sheet = await getSheet("Objeciones");
    await sheet.addRow({
      phone,
      categoria,
      texto_original: texto_original || "",
      paso_en_que_quedo: paso_en_que_quedo || "",
      creado_en: new Date().toISOString(),
    });
  } catch (err) {
    console.error("registrarObjecion falló:", err.message);
  }
}

// Conversaciones abandonadas: step ∈ ["mostro_operativos","eligio","dio_datos"]
// con ultima_actividad entre 24h y 72h atrás (para no spammear las muy viejas).
export async function getConversacionesAbandonadas() {
  const sheet = await getSheet("Conversaciones");
  const rows = await sheet.getRows();
  const ahora = Date.now();
  const min = ahora - 72 * 60 * 60 * 1000;
  const max = ahora - 24 * 60 * 60 * 1000;
  const pasosAbandonados = ["mostro_operativos", "eligio", "validando_rut"];

  return rows.filter((r) => {
    const step = r.get("step");
    if (!pasosAbandonados.includes(step)) return false;
    if (r.get("motivo_pedido") === "true") return false; // ya le preguntamos
    const ts = new Date(r.get("ultimo_mensaje")).getTime();
    return ts >= min && ts <= max;
  });
}

export async function marcarMotivoPedido(phone) {
  const sheet = await getSheet("Conversaciones");
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get("phone") === phone);
  if (row) {
    row.set("motivo_pedido", "true");
    await row.save();
  }
}

// ── Leads (Meta Lead Ads) ────────────────────────────────────────────────────
// Cada lead que llega vía formulario de Meta Ads se registra acá.
// El cron-engagement los usa para re-engagement.

export async function agregarLead({ phone, nombre, comuna, opt_in, origen_ad, form_id }) {
  try {
    const sheet = await getSheet("Leads");

    // Evitar duplicados por phone — si ya existe, actualizar última visita
    const rows = await sheet.getRows();
    const existente = rows.find((r) => r.get("phone") === phone);

    if (existente) {
      existente.set("ultima_actividad", new Date().toISOString());
      if (nombre && !existente.get("nombre")) existente.set("nombre", nombre);
      if (comuna && !existente.get("comuna")) existente.set("comuna", comuna);
      await existente.save();
      return { creado: false, row: existente };
    }

    await sheet.addRow({
      phone,
      nombre: nombre || "",
      comuna: comuna || "",
      opt_in: opt_in ? "true" : "false",
      origen_ad: origen_ad || "",
      form_id: form_id || "",
      estado: "nuevo",
      notificado: "false",
      creado_en: new Date().toISOString(),
      ultima_actividad: new Date().toISOString(),
    });
    return { creado: true };
  } catch (err) {
    console.error("agregarLead falló:", err.message);
    throw err;
  }
}

export async function getLeadsTibios({ desdeDias = 7, hastaDias = 14 } = {}) {
  const sheet = await getSheet("Leads");
  const rows = await sheet.getRows();
  const ahora = Date.now();
  const desdeMs = desdeDias * 24 * 60 * 60 * 1000;
  const hastaMs = hastaDias * 24 * 60 * 60 * 1000;

  return rows.filter((r) => {
    if (r.get("notificado") === "true") return false;
    if (r.get("opt_in") !== "true") return false;
    if (r.get("estado") === "convertido") return false;

    const creado = new Date(r.get("creado_en")).getTime();
    const edadMs = ahora - creado;
    return edadMs >= desdeMs && edadMs <= hastaMs;
  });
}

export async function getLeadsPorComuna(comuna) {
  const sheet = await getSheet("Leads");
  const rows = await sheet.getRows();
  return rows.filter(
    (r) =>
      r.get("comuna")?.toLowerCase() === comuna?.toLowerCase() &&
      r.get("opt_in") === "true" &&
      r.get("estado") !== "convertido"
  );
}

export async function marcarLeadNotificado(phone) {
  const sheet = await getSheet("Leads");
  const rows = await sheet.getRows();
  const row = rows.find((r) => r.get("phone") === phone);
  if (row) {
    row.set("notificado", "true");
    row.set("notificado_en", new Date().toISOString());
    await row.save();
  }
}

// ── Lista de espera ───────────────────────────────────────────────────────────
// Cuando un operativo está lleno o no hay operativos cerca de la comuna del lead,
// el agente lo anota acá para notificarlo cuando se libere cupo o haya operativo nuevo.

export async function agregarListaEspera({ phone, nombre, comuna, operativo_id_deseado, motivo }) {
  try {
    const sheet = await getSheet("ListaEspera");
    await sheet.addRow({
      phone,
      nombre: nombre || "",
      comuna: comuna || "",
      operativo_id_deseado: operativo_id_deseado || "",
      motivo: motivo || "",
      notificado: "false",
      creado_en: new Date().toISOString(),
    });
  } catch (err) {
    console.error("agregarListaEspera falló:", err.message);
    throw err;
  }
}

export async function getListaEsperaPorOperativo(operativoId) {
  const sheet = await getSheet("ListaEspera");
  const rows = await sheet.getRows();
  return rows.filter(
    (r) =>
      r.get("operativo_id_deseado") === operativoId &&
      r.get("notificado") !== "true"
  );
}

export async function marcarListaEsperaNotificado(phone, operativoId) {
  const sheet = await getSheet("ListaEspera");
  const rows = await sheet.getRows();
  const row = rows.find(
    (r) =>
      r.get("phone") === phone &&
      r.get("operativo_id_deseado") === operativoId
  );
  if (row) {
    row.set("notificado", "true");
    row.set("notificado_en", new Date().toISOString());
    await row.save();
  }
}

// ── FAQ (respuestas validadas, editables sin redeploy) ───────────────────────
// El agente busca matches por keywords en el mensaje del usuario y, si los hay,
// inyecta la respuesta validada al system prompt como contexto adicional.

export async function getFAQ() {
  try {
    const sheet = await getSheet("FAQ");
    const rows = await sheet.getRows();
    return rows
      .filter((r) => String(r.get("activo")).toLowerCase() === "true")
      .map((r) => ({
        pregunta: r.get("pregunta"),
        keywords: (r.get("keywords") || "")
          .split(",")
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean),
        respuesta: r.get("respuesta"),
      }));
  } catch (err) {
    console.error("getFAQ falló:", err.message);
    return [];
  }
}

// ── Funnel (instrumentación de conversión) ────────────────────────────────────
// Cada conversación genera múltiples eventos. La hoja "Funnel" guarda uno por fila.
// Eventos válidos: primer_msg, mostro_operativos, eligio_operativo, dio_datos,
// recibio_link, pago_completado, conversacion_abandonada.

export async function registrarEvento(phone, evento, metadata = {}) {
  try {
    const sheet = await getSheet("Funnel");
    await sheet.addRow({
      phone,
      evento,
      timestamp: new Date().toISOString(),
      metadata: JSON.stringify(metadata),
    });
  } catch (err) {
    // No fallar la conversación si la hoja Funnel no existe o falla
    console.error(`registrarEvento(${evento}) falló:`, err.message);
  }
}

function buildReminderText(tipo, { nombre, fecha, hora, lugar, direccion }) {
  const esHoy = tipo === "2h";
  return (
    `🔔 *Recordatorio — Lavado de Oídos*\n\n` +
    `Hola ${nombre} 👋\n` +
    (esHoy
      ? `¡Tu cita es *HOY* a las ${hora}! ⏰\n`
      : `Tu cita es *mañana* a las ${hora} 📅\n`) +
    `\n📍 *${lugar}*\n` +
    `🗺 ${direccion}\n\n` +
    `Recuerda llegar 5 minutos antes.\n` +
    `Si necesitas cancelar, escríbenos ahora. ¡Te esperamos! 👂`
  );
}
