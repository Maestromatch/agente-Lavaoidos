// api/lead-ads-webhook.js
// Recibe leads de Meta Lead Ads (formularios in-app).
// Flujo:
//   1. Meta envía POST con un leadgen_id por cada submit del formulario.
//   2. Validamos firma HMAC-SHA256 con LEAD_ADS_APP_SECRET.
//   3. Consultamos los campos del lead via Graph API usando WHATSAPP_TOKEN.
//   4. Registramos en hoja Leads + enviamos primer WhatsApp (ventana 24h abierta).

import crypto from "node:crypto";
import { sendWhatsAppMessage } from "../lib/whatsapp.js";
import { agregarLead, registrarEvento } from "../lib/sheets.js";
import { validarTelefonoCL } from "../lib/validators.js";

const GRAPH_VERSION = "v19.0";

export default async function handler(req, res) {
  // ── Verificación de webhook (Meta lo llama al registrar la URL) ─────────────
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== "POST") return res.status(405).end();

  // ── Validación de firma HMAC ────────────────────────────────────────────────
  const signature = req.headers["x-hub-signature-256"];
  const rawBody = JSON.stringify(req.body);
  if (process.env.LEAD_ADS_APP_SECRET && signature) {
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", process.env.LEAD_ADS_APP_SECRET)
        .update(rawBody)
        .digest("hex");
    if (signature !== expected) {
      console.error("Lead Ads: firma inválida");
      return res.status(401).end();
    }
  }

  // Responder 200 inmediatamente; procesamos en background
  res.status(200).json({ received: true });

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        await procesarLead(change.value);
      }
    }
  } catch (err) {
    console.error("Lead Ads webhook error:", err);
  }
}

async function procesarLead(value) {
  const { leadgen_id, form_id, ad_id } = value;
  if (!leadgen_id) return;

  // Obtener los campos del lead desde Graph API
  const fields = await fetchLeadFields(leadgen_id);
  if (!fields) return;

  // Extraer datos relevantes (los nombres dependen del form de Meta;
  // los más comunes son: full_name, phone_number, city)
  const nombre = fields.full_name || fields.first_name || "";
  const phoneRaw = fields.phone_number || "";
  const comuna = fields.city || fields.commune || fields.comuna || "";

  const phoneCheck = validarTelefonoCL(phoneRaw);
  if (!phoneCheck.valido) {
    console.warn(`Lead ${leadgen_id}: teléfono inválido (${phoneRaw})`);
    return;
  }
  const phone = phoneCheck.normalizado;

  // Registrar en hoja Leads
  await agregarLead({
    phone,
    nombre,
    comuna,
    opt_in: true,
    origen_ad: ad_id || form_id || "lead_ads",
    form_id,
  });

  await registrarEvento(phone, "lead_capturado", {
    origen: "meta_lead_ads",
    ad_id,
    form_id,
  });

  // Primer WhatsApp (ventana 24h recién abierta por el opt-in)
  const mensaje = construirMensajeBienvenida(nombre);
  try {
    await sendWhatsAppMessage(phone, mensaje);
  } catch (err) {
    console.error(`Lead ${phone}: no se pudo enviar mensaje:`, err.message);
  }
}

async function fetchLeadFields(leadgenId) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}?access_token=${process.env.WHATSAPP_TOKEN}`
    );
    if (!res.ok) {
      console.error(`fetchLeadFields ${leadgenId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    // field_data es un array [{name, values:[...]}]
    const fields = {};
    for (const f of data.field_data || []) {
      fields[f.name] = f.values?.[0];
    }
    return fields;
  } catch (err) {
    console.error("fetchLeadFields error:", err);
    return null;
  }
}

function construirMensajeBienvenida(nombre) {
  const saludo = nombre ? `Hola ${nombre.split(" ")[0]} 👋` : "Hola 👋";
  return (
    `${saludo}\n\n` +
    `Gracias por dejar tus datos. Te escribimos desde *Operativos de Lavado de Oídos* 👂\n\n` +
    `¿Te muestro los operativos disponibles esta semana? Responde *SI* y te paso la lista al instante.`
  );
}
