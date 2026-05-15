// api/webhook.js
// Vercel Serverless Function — punto de entrada principal de WhatsApp

import Anthropic from "@anthropic-ai/sdk";
import { sendWhatsAppMessage, markAsRead } from "../lib/whatsapp.js";
import { createPaymentLink } from "../lib/mercadopago.js";
import {
  getOperativosDisponibles,
  crearReserva,
  getConversacion,
  saveConversacion,
  registrarEvento,
} from "../lib/sheets.js";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  // ── Verificación del webhook (Meta lo llama una sola vez al registrar) ──────
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== "POST") return res.status(405).end();

  // Responder 200 de inmediato a Meta para evitar reintentos
  res.status(200).json({ status: "ok" });

  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const msg     = value?.messages?.[0];

    // Solo procesar mensajes de texto entrantes
    if (!msg || msg.type !== "text") return;

    const phone = msg.from;
    const text  = msg.text.body.trim();
    const msgId = msg.id;

    // Marcar como leído (ticks azules)
    await markAsRead(msgId).catch(() => {});

    // Ignorar mensajes vacíos
    if (!text) return;

    await processMessage(phone, text);
  } catch (err) {
    console.error("Webhook error:", err);
  }
}

// ── Lógica principal del agente ───────────────────────────────────────────────

async function processMessage(phone, userMessage) {
  // 1. Cargar estado de la conversación desde Google Sheets
  const { history, step, row: existingRow } = await getConversacion(phone);

  // Si es el primer mensaje del paciente, registrar entrada al funnel
  if (history.length === 0) {
    await registrarEvento(phone, "primer_msg", { texto: userMessage });
  }

  // 2. Agregar mensaje del usuario al historial
  history.push({ role: "user", content: userMessage });

  // 3. Obtener operativos disponibles (datos en tiempo real)
  const operativos = await getOperativosDisponibles();

  // 4. Construir system prompt con contexto actualizado
  const systemPrompt = buildSystemPrompt(operativos, step);

  // 5. Llamar a Claude con historial completo
  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    system: systemPrompt,
    messages: history,
  });

  let assistantText = response.content[0].text;

  // 6. Detectar y ejecutar acciones especiales del agente
  const action = extractAction(assistantText);
  let finalText = removeActionTag(assistantText);
  let newStep   = step;

  if (action?.type === "CREAR_RESERVA") {
    const op = operativos.find((o) => o.id === action.operativo_id) || operativos[0];

    if (op) {
      const reservaId = `RES-${Date.now()}`;

      const link = await createPaymentLink({
        id: reservaId,
        title: `Lavado de Oídos — ${op.lugar} ${op.fecha}`,
        price: op.precio,
        phone,
        nombre: action.nombre,
        rut: action.rut,
        operativo_id: op.id,
      });

      await crearReserva({
        id: reservaId,
        phone,
        nombre: action.nombre,
        rut: action.rut,
        operativo_id: op.id,
        operativo_lugar: op.lugar,
        operativo_fecha: op.fecha,
        operativo_hora: op.hora,
        operativo_direccion: op.direccion,
        precio: op.precio,
        link_pago: link,
      });

      finalText = finalText.replace("{{LINK_PAGO}}", link);
      newStep = "esperando_pago";

      // Funnel: dio datos completos y recibió link de pago
      await registrarEvento(phone, "dio_datos", {
        nombre: action.nombre,
        rut: action.rut,
        operativo_id: op.id,
      });
      await registrarEvento(phone, "recibio_link", { reserva_id: reservaId });
    }
  }

  // Reemplazar placeholder de lista de operativos si el agente lo incluyó
  if (finalText.includes("{{OPERATIVOS}}")) {
    finalText = finalText.replace("{{OPERATIVOS}}", formatOperativos(operativos));
    // Funnel: el agente mostró el catálogo (solo en flujo normal)
    if (step !== "esperando_pago") {
      await registrarEvento(phone, "mostro_operativos", {
        cantidad: operativos.length,
      });
    }
  }

  // 7. Enviar respuesta por WhatsApp
  await sendWhatsAppMessage(phone, finalText);

  // 8. Guardar historial y step actualizados
  history.push({ role: "assistant", content: assistantText });
  await saveConversacion(phone, { history, step: newStep }, existingRow);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(operativos, step) {
  const hayOperativos = operativos.length > 0;

  return `Eres el asistente virtual de *Operativos de Lavado de Oídos* en la Región Metropolitana de Chile.
Tu único trabajo es ayudar al paciente a reservar y pagar su cupo en el próximo operativo.

PERSONALIDAD:
- Cálido, profesional y muy conciso. Máximo 4 líneas por mensaje.
- Español chileno natural. Tutear siempre.
- 1–2 emojis por mensaje, no más.
- Nunca inventes información. Si no sabes algo, di "te confirmo en breve".

SERVICIO QUE SE OFRECE:
- Operativo de lavado de oídos realizado por fonoaudiólogo certificado.
- Incluye: evaluación otoscópica + lavado de oídos + educación en autocuidado auditivo.
- Duración por paciente: 15–20 minutos.
- Apto para niños, adultos y adultos mayores.
- Contraindicado si el paciente tiene perforación timpánica conocida (derivar al otorrino).
- Solo se acepta pago online mediante el link que se envía. No se aceptan transferencias.

OPERATIVOS DISPONIBLES (tiempo real):
${hayOperativos ? JSON.stringify(operativos, null, 2) : "No hay operativos activos actualmente."}

ESTADO ACTUAL DE LA CONVERSACIÓN: ${step}

FLUJO QUE DEBES SEGUIR:
1. Saluda y presenta el servicio brevemente.
2. Muestra los operativos disponibles (usa {{OPERATIVOS}} para que el sistema los formatee).
3. El paciente elige un operativo. Confirma la elección.
4. Pide nombre completo y RUT.
5. Cuando tengas nombre + RUT + operativo elegido, incluye la acción especial (ver abajo) y escribe {{LINK_PAGO}} donde debe aparecer el link.
6. Indica que al pagar queda confirmado automáticamente y recibirá recordatorios.

ACCIÓN ESPECIAL (incluir cuando tengas todos los datos):
[ACTION:CREAR_RESERVA|operativo_id:ID_AQUI|nombre:NOMBRE_COMPLETO|rut:RUT_AQUI]

Ejemplo de mensaje al generar el link:
"¡Perfecto! Tu reserva está casi lista 🎉
Paga aquí para confirmar tu cupo: {{LINK_PAGO}}
El link expira en 24 horas. Al pagar, te llegará la confirmación. 👂"

REGLAS ESTRICTAS:
- Si el paciente menciona perforación timpánica → no agendar, sugerir otorrino.
- Si no hay operativos → avisar amablemente y ofrecer anotarlos en lista de espera.
- Si preguntan por transferencia → explicar que solo se acepta pago online.
- Si ya están en paso "esperando_pago" → recordar que deben completar el pago del link enviado.`;
}

function extractAction(text) {
  const match = text.match(/\[ACTION:(\w+)\|([^\]]+)\]/);
  if (!match) return null;

  const type   = match[1];
  const params = {};
  match[2].split("|").forEach((p) => {
    const idx = p.indexOf(":");
    if (idx > -1) {
      params[p.slice(0, idx)] = p.slice(idx + 1);
    }
  });
  return { type, ...params };
}

function removeActionTag(text) {
  return text.replace(/\[ACTION:[^\]]+\]/g, "").trim();
}

function formatOperativos(operativos) {
  if (!operativos.length) {
    return "⚠️ No hay operativos disponibles por ahora. Escríbenos para anotarte en la lista de espera.";
  }
  return operativos
    .map(
      (op, i) =>
        `*${i + 1}. ${op.lugar}*\n` +
        `📅 ${op.fecha} a las ${op.hora}\n` +
        `📍 ${op.direccion}\n` +
        `💰 $${op.precio.toLocaleString("es-CL")}\n` +
        `🪑 ${op.cupos_disponibles} cupos disponibles`
    )
    .join("\n\n");
}
