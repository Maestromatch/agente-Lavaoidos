// lib/templates.js
// Envío de plantillas pre-aprobadas de WhatsApp Cloud API.
// Fuera de la ventana de 24h, solo plantillas funcionan.

const GRAPH_VERSION = "v19.0";

/**
 * Envía una plantilla aprobada a un destinatario.
 * @param {string} to - número en formato 569XXXXXXXX
 * @param {string} name - nombre exacto de la plantilla aprobada en Meta
 * @param {Array<string>} params - parámetros del body en orden (rellenan {{1}}, {{2}}, ...)
 * @param {string} [lang] - código de idioma usado al subir la plantilla. Default: env var.
 */
export async function sendTemplate(to, name, params = [], lang = null) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const language = lang || process.env.WHATSAPP_TEMPLATE_LANG || "es";

  const components = params.length
    ? [
        {
          type: "body",
          parameters: params.map((p) => ({ type: "text", text: String(p) })),
        },
      ]
    : undefined;

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(components ? { components } : {}),
    },
  };

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`sendTemplate(${name}) error:`, err);
    throw new Error(`WhatsApp template error: ${res.status}`);
  }

  return res.json();
}

// Nombres de plantillas — debe coincidir con los aprobados en Meta.
// Si cambian, editar acá y solo acá.
export const TEMPLATE_NAMES = {
  RECORDATORIO_OPERATIVO_PROXIMO: "recordatorio_operativo_proximo",
  NUEVO_OPERATIVO_ZONA: "nuevo_operativo_zona",
  CUPO_LIBERADO: "cupo_liberado",
  BIENVENIDA_LEAD_ADS: "bienvenida_lead_ads",
};
