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
  getFAQ,
  agregarListaEspera,
  registrarObjecion,
} from "../lib/sheets.js";
import { validarRut } from "../lib/validators.js";
import { buscarWeb } from "../lib/web-research.js";

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WEB_TOOL = {
  name: "buscar_web",
  description:
    "Busca información actualizada en internet sobre dudas técnicas del paciente " +
    "(otoscopía, cerumen, audífonos, contraindicaciones específicas, etc.). " +
    "Usar SOLO cuando el paciente pregunte algo que no está en la INFORMACIÓN " +
    "ADICIONAL VALIDADA del system prompt y la respuesta requiera datos técnicos " +
    "o estudios. No usar para preguntas administrativas (precio, horarios, reservas).",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Consulta corta y específica en español. Ej: 'cuántas veces al año se recomienda lavar los oídos'",
      },
    },
    required: ["query"],
  },
};

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

  // 3. Obtener operativos disponibles + FAQ (datos en tiempo real)
  const [operativos, faqAll] = await Promise.all([
    getOperativosDisponibles(),
    getFAQ(),
  ]);

  // Filtrar FAQs relevantes al mensaje actual del usuario
  const faqRelevantes = matchFAQ(userMessage, faqAll);

  // 4. Construir system prompt con contexto actualizado
  const systemPrompt = buildSystemPrompt(operativos, step, faqRelevantes);

  // 5. Llamar a Claude con historial completo (con loop de tool_use si Tavily está habilitada)
  const { response, finalAssistantContent } = await callClaudeWithTools(
    systemPrompt,
    history,
    phone
  );

  // Extraer texto final del último mensaje del assistant
  const textBlock = response.content.find((c) => c.type === "text");
  let assistantText =
    textBlock?.text ||
    "Disculpa, déjame revisar eso. ¿Puedes contarme un poco más?";

  // 6. Detectar y ejecutar acciones especiales del agente
  const action = extractAction(assistantText);
  let finalText = removeActionTag(assistantText);
  let newStep   = step;

  if (action?.type === "CREAR_RESERVA") {
    // Validar RUT antes de crear reserva. Si inválido, sobrescribir respuesta
    // pidiendo corrección sin avanzar al pago.
    const rutCheck = validarRut(action.rut);
    if (!rutCheck.valido) {
      finalText =
        `Tu RUT no parece válido (${rutCheck.motivo}). ` +
        `¿Me lo confirmas con formato 12.345.678-5? 🪪`;
      newStep = "validando_rut";
      await registrarEvento(phone, "rut_invalido", {
        rut_intentado: action.rut,
        motivo: rutCheck.motivo,
      });
      // Saltar la creación de reserva
      action.type = "_SKIP";
    } else {
      // Usar la versión normalizada en todos los registros
      action.rut = rutCheck.normalizado;
    }
  }

  if (action?.type === "REGISTRAR_MOTIVO") {
    await registrarObjecion({
      phone,
      categoria: action.categoria || "otro",
      texto_original: userMessage,
      paso_en_que_quedo: step,
    });
    await registrarEvento(phone, "motivo_registrado", {
      categoria: action.categoria,
    });
  }

  if (action?.type === "LISTA_ESPERA") {
    try {
      await agregarListaEspera({
        phone,
        nombre: action.nombre,
        comuna: action.comuna,
        operativo_id_deseado: action.operativo_id_deseado,
        motivo: action.motivo || "cupo_agotado",
      });
      await registrarEvento(phone, "anotado_lista_espera", {
        comuna: action.comuna,
        operativo_id_deseado: action.operativo_id_deseado,
      });
      newStep = "en_lista_espera";
    } catch (err) {
      console.error("Error agregando a lista de espera:", err);
    }
  }

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

// ── Llamada a Claude con loop de tool_use ─────────────────────────────────────
// Si TAVILY_API_KEY está configurada, registramos el tool buscar_web.
// Loop hasta máximo 2 iteraciones (1 búsqueda permitida por mensaje del usuario).

async function callClaudeWithTools(systemPrompt, baseHistory, phone) {
  const tavilyOn = !!process.env.TAVILY_API_KEY;
  const messages = baseHistory.map((m) => ({ ...m }));
  const MAX_ITER = 2;

  let response;
  let iter = 0;

  while (iter < MAX_ITER) {
    iter++;

    response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: systemPrompt,
      messages,
      ...(tavilyOn ? { tools: [WEB_TOOL] } : {}),
    });

    if (response.stop_reason !== "tool_use") break;

    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse) break;

    // Ejecutar el tool
    let toolResult = "No se obtuvo información.";
    if (toolUse.name === "buscar_web") {
      const data = await buscarWeb(toolUse.input?.query || "");
      if (data) {
        toolResult =
          `Resumen: ${data.resumen}\n\n` +
          `Fuentes:\n${data.fuentes
            .map((f, i) => `${i + 1}. ${f.title}\n   ${f.snippet}`)
            .join("\n")}`;
        await registrarEvento(phone, "web_research_usado", {
          query: toolUse.input?.query,
          n_fuentes: data.fuentes.length,
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: toolResult,
        },
      ],
    });
  }

  return { response, finalAssistantContent: response.content };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(operativos, step, faqRelevantes = []) {
  const hayOperativos = operativos.length > 0;

  const bloqueFAQ = faqRelevantes.length
    ? `\nINFORMACIÓN ADICIONAL VALIDADA (usar SOLO si responde la duda actual del paciente):\n${faqRelevantes
        .map((f) => `• ${f.pregunta}\n  → ${f.respuesta}`)
        .join("\n")}\n`
    : "";

  return `Eres el asistente virtual de *Operativos de Lavado de Oídos* en la Región Metropolitana de Chile.
Tu único trabajo es ayudar al paciente a reservar y pagar su cupo en el próximo operativo, y vencer sus objeciones con honestidad.

PERSONALIDAD:
- Cálido, profesional y muy conciso. Máximo 4 líneas por mensaje.
- Español chileno natural. Tutear siempre.
- 1–2 emojis por mensaje, no más.
- Nunca inventes información. Si no sabes algo, di "te confirmo en breve".
- Toma iniciativa: si el paciente duda, pregunta qué le frena y resuelve.

SERVICIO QUE SE OFRECE:
- Operativo de lavado de oídos realizado por fonoaudiólogo certificado.
- Incluye: evaluación otoscópica + lavado de oídos + educación en autocuidado auditivo.
- Duración por paciente: 15–20 minutos.
- Apto para niños, adultos y adultos mayores.
- Contraindicado si el paciente tiene perforación timpánica conocida (derivar al otorrino).
- Solo se acepta pago online mediante el link que se envía. No se aceptan transferencias.

OPERATIVOS DISPONIBLES (tiempo real):
${hayOperativos ? JSON.stringify(operativos, null, 2) : "No hay operativos activos actualmente."}
${bloqueFAQ}
ESTADO ACTUAL DE LA CONVERSACIÓN: ${step}

FLUJO QUE DEBES SEGUIR:
1. Saluda y presenta el servicio brevemente.
2. Muestra los operativos disponibles (usa {{OPERATIVOS}} para que el sistema los formatee).
3. El paciente elige un operativo. Confirma la elección.
4. Pide nombre completo y RUT.
5. Cuando tengas nombre + RUT + operativo elegido, incluye la acción especial (ver abajo) y escribe {{LINK_PAGO}} donde debe aparecer el link.
6. Indica que al pagar queda confirmado automáticamente y recibirá recordatorios.

ACCIONES ESPECIALES (incluir UNA cuando corresponda; el sistema las procesa):

1. CREAR_RESERVA — cuando tengas nombre + RUT + operativo_id elegido:
   [ACTION:CREAR_RESERVA|operativo_id:ID_AQUI|nombre:NOMBRE_COMPLETO|rut:RUT_AQUI]
   Escribe {{LINK_PAGO}} donde debe aparecer el link.

   Ejemplo:
   "¡Perfecto! Tu reserva está casi lista 🎉
   Paga aquí para confirmar tu cupo: {{LINK_PAGO}}
   El link expira en 24 horas. Al pagar, te llegará la confirmación. 👂"

2. LISTA_ESPERA — cuando no hay operativos disponibles, el operativo elegido está
   lleno, o no hay operativo cerca de la comuna del paciente. Pide primero
   nombre + comuna si no los tienes:
   [ACTION:LISTA_ESPERA|nombre:NOMBRE|comuna:COMUNA|operativo_id_deseado:ID_O_VACIO|motivo:cupo_agotado|sin_operativos|fuera_de_zona]

   Ejemplo:
   "Te anoté en la lista de espera, {{nombre}} 📋
   Te avisaré apenas se libere un cupo o programe un operativo cerca tuyo.
   No pierdes tu lugar 👂"

3. REGISTRAR_MOTIVO — SOLO cuando un paciente que abandonó una conversación
   responde al mensaje "¿qué te frenó?" con un motivo claro. Categoriza el motivo
   en uno de: precio, tiempo, confianza, ubicacion, indecision, contraindicacion, otro.
   [ACTION:REGISTRAR_MOTIVO|categoria:precio]
   Después, si el paciente quiere retomar, continúa el flujo normal. Si no,
   agradece y cierra amablemente.

OBJECIONES COMUNES Y CÓMO RESPONDER:
- *"Está caro"* → Reforzar valor: "Incluye otoscopía + lavado + educación, todo por fonoaudiólogo, en menos de 20 min. Una consulta privada equivale a 3x este precio." Si insiste, ofrecer recordarle el próximo operativo más económico.
- *"Está lejos / no me queda cerca"* → Mostrar el operativo más cercano disponible. Si ninguno es cercano, ofrecer anotarlo en lista de espera para su zona.
- *"No conozco / no confío"* → Mencionar fonoaudiólogo certificado, garantía profesional, foto del lugar si la pide. Nunca exagerar.
- *"Estoy ocupado / no tengo tiempo"* → Recalcar que son 15-20 min, ofrecer el horario más temprano/tarde del operativo más conveniente.
- *"Necesito pensarlo"* → No presionar. Validar la decisión y ofrecer que lo agendamos cuando confirme. Avisar que los cupos son limitados.
- *Dudas técnicas* ("¿duele?", "¿es seguro?", "¿qué pasa si tengo cera dura?") → Responder con honestidad técnica desde la INFORMACIÓN ADICIONAL VALIDADA. Si la pregunta es muy específica, decir "te confirmo en breve con la fonoaudióloga".

REGLAS ESTRICTAS:
- Si el paciente menciona perforación timpánica → no agendar, sugerir otorrino.
- Si no hay operativos → avisar y ofrecer LISTA_ESPERA (pidiendo nombre+comuna).
- Si el operativo elegido está sin cupos → ofrecer otro operativo o LISTA_ESPERA.
- Si preguntan por transferencia → explicar que solo se acepta pago online.
- Si ya están en paso "esperando_pago" → recordar que deben completar el pago del link enviado.
- Si están en paso "en_lista_espera" → confirmar que están anotados y agradecer la paciencia.
- Si están en paso "validando_rut" → pedir el RUT correcto y reusar la acción CREAR_RESERVA cuando lo den.
- Nunca prometer descuentos sin tener autorización explícita en la INFORMACIÓN ADICIONAL VALIDADA.`;
}

// Devuelve las FAQs cuyas keywords aparecen en el mensaje del usuario.
// Hasta 3 matches para no inflar el system prompt.
function matchFAQ(userMessage, faqs) {
  const lower = userMessage.toLowerCase();
  const matches = faqs.filter((f) =>
    f.keywords.some((k) => k.length > 2 && lower.includes(k))
  );
  return matches.slice(0, 3);
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
