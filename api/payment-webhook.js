// api/payment-webhook.js
// Mercadopago llama a este endpoint cuando se procesa un pago.
// Confirma la reserva, descuenta el cupo y programa recordatorios automáticos.

import { MercadoPagoConfig, Payment } from "mercadopago";
import { sendWhatsAppMessage } from "../lib/whatsapp.js";
import {
  confirmarReserva,
  descontarCupo,
  agendarRecordatorios,
  registrarEvento,
} from "../lib/sheets.js";

const mp = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Mercadopago espera 200 de inmediato para no reintentar
  res.status(200).json({ received: true });

  try {
    const { type, data } = req.body;

    // Solo procesar eventos de pago
    if (type !== "payment" || !data?.id) return;

    // Consultar el pago real a Mercadopago para verificar el estado
    const paymentApi = new Payment(mp);
    const payment = await paymentApi.get({ id: data.id });

    // Solo actuar sobre pagos aprobados
    if (payment.status !== "approved") return;

    const reservaId = payment.external_reference;
    const meta      = payment.metadata || {};
    const monto     = payment.transaction_amount;

    // 1. Confirmar reserva en Google Sheets (retorna null si ya fue procesada)
    const reserva = await confirmarReserva(reservaId, payment.id);
    if (!reserva) return; // pago duplicado o ya procesado

    // Funnel: pago completado (evento final del embudo)
    await registrarEvento(reserva.phone, "pago_completado", {
      reserva_id: reservaId,
      payment_id: payment.id,
      monto,
      operativo_id: reserva.operativo_id,
    });

    // 2. Descontar cupo del operativo
    await descontarCupo(reserva.operativo_id);

    // 3. Enviar confirmación al paciente por WhatsApp
    await sendWhatsAppMessage(reserva.phone, buildConfirmationMessage(reserva));

    // 4. Notificar al administrador
    await sendWhatsAppMessage(
      process.env.ADMIN_PHONE,
      `✅ *Nueva reserva confirmada*\n\n` +
      `👤 ${reserva.nombre}\n` +
      `🪪 ${reserva.rut}\n` +
      `📱 ${reserva.phone}\n` +
      `📅 ${reserva.operativo_fecha} ${reserva.operativo_hora}\n` +
      `📍 ${reserva.operativo_lugar}\n` +
      `💰 $${Number(monto).toLocaleString("es-CL")}\n` +
      `🆔 ${reservaId}`
    );

    // 5. Programar recordatorios automáticos (48h y 2h antes)
    await agendarRecordatorios({
      phone:     reserva.phone,
      nombre:    reserva.nombre,
      fecha:     reserva.operativo_fecha,
      hora:      reserva.operativo_hora,
      lugar:     reserva.operativo_lugar,
      direccion: reserva.operativo_direccion,
    });

  } catch (err) {
    console.error("Payment webhook error:", err);
  }
}

function buildConfirmationMessage(reserva) {
  return (
    `✅ *¡Reserva confirmada!* 🎉\n\n` +
    `Hola ${reserva.nombre}, tu pago fue recibido y tu cupo quedó asegurado 🩺\n\n` +
    `*Detalles de tu cita:*\n` +
    `📅 ${reserva.operativo_fecha} a las ${reserva.operativo_hora}\n` +
    `📍 ${reserva.operativo_lugar}\n` +
    (reserva.operativo_direccion ? `🗺 ${reserva.operativo_direccion}\n` : "") +
    `\n*¿Qué debes saber?*\n` +
    `• Llega 5 minutos antes de tu hora.\n` +
    `• Si usas audífonos, tráelos para revisarlos.\n` +
    `• Para cancelar, escríbenos con al menos 24h de anticipación.\n\n` +
    `Te enviaremos recordatorios 48h y 2h antes de tu cita.\n\n` +
    `¡Hasta pronto! 👂`
  );
}
