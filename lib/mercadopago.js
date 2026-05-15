// lib/mercadopago.js
import { MercadoPagoConfig, Preference } from "mercadopago";

const mp = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

/**
 * Crea una preferencia de pago en Mercadopago y retorna el link de pago.
 * @param {object} data
 * @param {string} data.id        - ID único de la reserva
 * @param {string} data.title     - Descripción del ítem
 * @param {number} data.price     - Precio en pesos chilenos
 * @param {string} data.phone     - Teléfono del comprador (para webhook)
 * @param {string} data.nombre    - Nombre del paciente
 * @param {string} data.rut       - RUT del paciente
 * @param {string} data.operativo_id
 */
export async function createPaymentLink(data) {
  const preference = new Preference(mp);

  const result = await preference.create({
    body: {
      external_reference: data.id,
      items: [
        {
          id: data.operativo_id,
          title: data.title,
          quantity: 1,
          unit_price: data.price,
          currency_id: "CLP",
        },
      ],
      payer: {
        name: data.nombre,
        phone: { number: data.phone },
      },
      // Webhooks de Mercadopago → tu endpoint /api/payment-webhook
      notification_url: `${process.env.APP_URL}/api/payment-webhook`,
      back_urls: {
        success: `${process.env.APP_URL}/pago-exitoso`,
        failure: `${process.env.APP_URL}/pago-fallido`,
        pending: `${process.env.APP_URL}/pago-pendiente`,
      },
      auto_return: "approved",
      // Metadata para el webhook de confirmación
      metadata: {
        reserva_id: data.id,
        phone: data.phone,
        nombre: data.nombre,
        rut: data.rut,
        operativo_id: data.operativo_id,
      },
      // Expirar el link en 24 horas si no se paga
      expiration_date_to: new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ).toISOString(),
      expires: true,
    },
  });

  // init_point = link de pago real (sandbox: sandbox_init_point)
  const isProd = process.env.NODE_ENV === "production";
  return isProd ? result.init_point : result.sandbox_init_point;
}
