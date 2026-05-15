// lib/whatsapp.js
// Cliente para WhatsApp Cloud API (Meta) — envío de mensajes y marca de lectura.

const GRAPH_VERSION = "v19.0";

function buildUrl(path) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/${path}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function sendWhatsAppMessage(to, text) {
  const res = await fetch(buildUrl("messages"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("WhatsApp send error:", err);
    throw new Error(`WhatsApp API error: ${res.status}`);
  }

  return res.json();
}

export async function markAsRead(messageId) {
  const res = await fetch(buildUrl("messages"), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("WhatsApp markAsRead error:", err);
  }
}
