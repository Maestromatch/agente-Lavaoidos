// api/cron-weekly-report.js
// Vercel Cron domingo 20:00 Chile (= 23 UTC en horario estándar, 00 UTC en
// verano). Lee el funnel + reservas de los últimos 7 días, calcula KPIs y
// manda un WhatsApp con resumen + 2-3 recomendaciones generadas por Claude.

import Anthropic from "@anthropic-ai/sdk";
import { sendWhatsAppMessage } from "../lib/whatsapp.js";
import { getSheet } from "../lib/sheets.js";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const kpis = await calcularKPIs(7);
    const recomendaciones = await generarRecomendaciones(kpis);
    const mensaje = formatearReporte(kpis, recomendaciones);

    await sendWhatsAppMessage(process.env.ADMIN_PHONE, mensaje);
    return res.status(200).json({ enviado: true, kpis });
  } catch (err) {
    console.error("Weekly report error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function calcularKPIs(ventanaDias) {
  const desde = Date.now() - ventanaDias * 24 * 60 * 60 * 1000;

  // Funnel: contar eventos únicos por phone+tipo
  const funnelSheet = await getSheet("Funnel");
  const eventosRows = await funnelSheet.getRows();
  const eventos = eventosRows
    .filter((r) => new Date(r.get("timestamp")).getTime() >= desde)
    .map((r) => ({ phone: r.get("phone"), evento: r.get("evento") }));

  const phonesPorEvento = (tipo) =>
    new Set(eventos.filter((e) => e.evento === tipo).map((e) => e.phone));

  const primerMsg = phonesPorEvento("primer_msg");
  const mostroOperativos = phonesPorEvento("mostro_operativos");
  const dioDatos = phonesPorEvento("dio_datos");
  const recibioLink = phonesPorEvento("recibio_link");
  const pagoCompletado = phonesPorEvento("pago_completado");
  const rutInvalido = phonesPorEvento("rut_invalido");
  const anotadoListaEspera = phonesPorEvento("anotado_lista_espera");

  // Reservas confirmadas con monto
  const reservasSheet = await getSheet("Reservas");
  const reservasRows = await reservasSheet.getRows();
  const reservasSemana = reservasRows.filter(
    (r) =>
      r.get("estado") === "confirmada" &&
      new Date(r.get("confirmado_en") || r.get("creado_en")).getTime() >= desde
  );
  const ingresoTotal = reservasSemana.reduce(
    (acc, r) => acc + Number(r.get("precio") || 0),
    0
  );

  // Top operativos por reservas
  const reservasPorOperativo = {};
  for (const r of reservasSemana) {
    const lugar = r.get("operativo_lugar");
    reservasPorOperativo[lugar] = (reservasPorOperativo[lugar] || 0) + 1;
  }
  const topOperativos = Object.entries(reservasPorOperativo)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Tasas de conversión
  const total = primerMsg.size;
  const tasa = (sub) =>
    total === 0 ? 0 : Math.round((sub.size / total) * 100);

  return {
    ventanaDias,
    leads: total,
    mostro_operativos: mostroOperativos.size,
    dio_datos: dioDatos.size,
    recibio_link: recibioLink.size,
    pago_completado: pagoCompletado.size,
    rut_invalido: rutInvalido.size,
    lista_espera: anotadoListaEspera.size,
    tasa_mostro: tasa(mostroOperativos),
    tasa_datos: tasa(dioDatos),
    tasa_link: tasa(recibioLink),
    tasa_cierre: tasa(pagoCompletado),
    ingreso_total: ingresoTotal,
    top_operativos: topOperativos,
  };
}

async function generarRecomendaciones(kpis) {
  // Si no hay datos, no llamar a Claude.
  if (kpis.leads === 0) return ["Aún no hay datos suficientes esta semana."];

  const prompt = `Eres asesor de marketing y operaciones para un servicio de lavado de oídos en Chile que opera por WhatsApp.

KPIs últimos ${kpis.ventanaDias} días:
- Leads (primer mensaje): ${kpis.leads}
- Vieron operativos: ${kpis.mostro_operativos} (${kpis.tasa_mostro}%)
- Dieron datos completos: ${kpis.dio_datos} (${kpis.tasa_datos}%)
- Recibieron link de pago: ${kpis.recibio_link} (${kpis.tasa_link}%)
- Pagaron: ${kpis.pago_completado} (${kpis.tasa_cierre}%)
- RUTs inválidos detectados: ${kpis.rut_invalido}
- Lista de espera: ${kpis.lista_espera}
- Ingreso total: $${kpis.ingreso_total.toLocaleString("es-CL")} CLP
- Top operativos: ${kpis.top_operativos.map(([l, n]) => `${l} (${n})`).join(", ") || "N/A"}

Entrega 3 recomendaciones accionables y concretas para mejorar la próxima semana.
Formato: una línea por recomendación, máximo 100 caracteres cada una. Sin numerar, sin emojis.`;

  try {
    const resp = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.text || "";
    return text.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  } catch (err) {
    console.error("Recomendaciones falló:", err.message);
    return ["No se pudieron generar recomendaciones esta semana."];
  }
}

function formatearReporte(k, recs) {
  const cierre = k.leads
    ? `${k.tasa_cierre}% (${k.pago_completado}/${k.leads})`
    : "sin datos";

  return (
    `📊 *Reporte semanal — Lavado de Oídos*\n` +
    `Últimos ${k.ventanaDias} días\n\n` +
    `*Funnel:*\n` +
    `• ${k.leads} leads iniciaron conversación\n` +
    `• ${k.mostro_operativos} vieron operativos (${k.tasa_mostro}%)\n` +
    `• ${k.dio_datos} dieron datos (${k.tasa_datos}%)\n` +
    `• ${k.recibio_link} recibieron link (${k.tasa_link}%)\n` +
    `• *${k.pago_completado} pagaron* — cierre: ${cierre}\n\n` +
    `*Otros datos:*\n` +
    `• Ingreso: $${k.ingreso_total.toLocaleString("es-CL")}\n` +
    `• RUTs inválidos: ${k.rut_invalido}\n` +
    `• Lista de espera: ${k.lista_espera}\n` +
    (k.top_operativos.length
      ? `• Top: ${k.top_operativos.map(([l, n]) => `${l} (${n})`).join(", ")}\n`
      : "") +
    `\n*Recomendaciones:*\n` +
    recs.map((r) => `• ${r}`).join("\n")
  );
}
