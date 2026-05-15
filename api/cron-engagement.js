// api/cron-engagement.js
// Vercel Cron diario (10:00 AM). Hace 3 cosas:
//   1. Recuerda a leads tibios (7-14 días sin reservar) con template
//      recordatorio_operativo_proximo.
//   2. Notifica leads cuya comuna matchea operativos nuevos cargados (≤7 días)
//      con template nuevo_operativo_zona.
//   3. (Stub) Notifica lista de espera cuando se libera cupo. La lógica de
//      liberación vive en payment-webhook.js cuando se procesen cancelaciones
//      (Fase 4 futura).

import {
  getLeadsTibios,
  getLeadsPorComuna,
  marcarLeadNotificado,
  getSheet,
  getOperativosDisponibles,
} from "../lib/sheets.js";
import { sendTemplate, TEMPLATE_NAMES } from "../lib/templates.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const resumen = {
    leads_tibios_notificados: 0,
    leads_zona_notificados: 0,
    errores: 0,
  };

  try {
    const operativos = await getOperativosDisponibles();

    // ── 1. Leads tibios ──────────────────────────────────────────────────────
    const tibios = await getLeadsTibios({ desdeDias: 7, hastaDias: 14 });
    const proximo = elegirOperativoMasProximo(operativos);

    for (const lead of tibios) {
      if (!proximo) break; // sin operativos no hay nada que recordar
      try {
        await sendTemplate(
          lead.get("phone"),
          TEMPLATE_NAMES.RECORDATORIO_OPERATIVO_PROXIMO,
          [
            lead.get("nombre") || "estimado/a",
            formatFecha(proximo.fecha),
            proximo.lugar,
            String(proximo.cupos_disponibles),
          ]
        );
        await marcarLeadNotificado(lead.get("phone"));
        resumen.leads_tibios_notificados++;
      } catch (err) {
        console.error(`Lead tibio ${lead.get("phone")}:`, err.message);
        resumen.errores++;
      }
    }

    // ── 2. Operativos nuevos por zona ────────────────────────────────────────
    const operativosRecientes = await getOperativosRecientes(7);
    for (const op of operativosRecientes) {
      if (!op.direccion) continue;
      const comuna = extraerComuna(op.direccion);
      if (!comuna) continue;

      const leadsZona = await getLeadsPorComuna(comuna);
      for (const lead of leadsZona) {
        if (lead.get("notificado") === "true") continue;
        try {
          await sendTemplate(
            lead.get("phone"),
            TEMPLATE_NAMES.NUEVO_OPERATIVO_ZONA,
            [
              lead.get("nombre") || "estimado/a",
              `${formatFecha(op.fecha)} a las ${op.hora}`,
              op.lugar,
              Number(op.precio).toLocaleString("es-CL"),
            ]
          );
          await marcarLeadNotificado(lead.get("phone"));
          resumen.leads_zona_notificados++;
        } catch (err) {
          console.error(`Lead zona ${lead.get("phone")}:`, err.message);
          resumen.errores++;
        }
      }
    }
  } catch (err) {
    console.error("Cron engagement error:", err);
    return res.status(500).json({ error: err.message, resumen });
  }

  console.log("Cron engagement:", resumen);
  res.status(200).json(resumen);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function elegirOperativoMasProximo(operativos) {
  if (!operativos.length) return null;
  return operativos
    .slice()
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))[0];
}

async function getOperativosRecientes(diasAtras) {
  const sheet = await getSheet("Operativos");
  const rows = await sheet.getRows();
  const hace = Date.now() - diasAtras * 24 * 60 * 60 * 1000;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  return rows
    .filter((r) => {
      const fechaFutura = new Date(r.get("fecha")) >= hoy;
      const cupos = Number(r.get("cupos_disponibles")) > 0;
      const activo = String(r.get("activo")).toLowerCase() === "true";
      // Si tiene timestamp de creación, usar; si no, asumir reciente
      const cargado = r.get("creado_en")
        ? new Date(r.get("creado_en")).getTime() >= hace
        : true;
      return fechaFutura && cupos && activo && cargado;
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

function formatFecha(isoDate) {
  // "2026-05-20" → "20 de mayo"
  if (!isoDate) return "";
  const meses = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!d || !m) return isoDate;
  return `${d} de ${meses[m - 1]}`;
}

function extraerComuna(direccion) {
  // Heurística simple: la comuna suele estar después de la última coma.
  // "Av. Irarrázaval 1234, Ñuñoa" → "Ñuñoa"
  if (!direccion) return null;
  const partes = direccion.split(",").map((s) => s.trim());
  return partes[partes.length - 1] || null;
}
