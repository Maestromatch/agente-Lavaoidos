// api/cron-reminders.js
// Vercel Cron Job — se ejecuta cada 30 minutos.
// Revisa la pestaña "Recordatorios" y envía los que ya deberían haberse enviado.

import { getSheet } from "../lib/sheets.js";
import { sendWhatsAppMessage } from "../lib/whatsapp.js";

export default async function handler(req, res) {
  // Vercel Cron envía el CRON_SECRET en el header Authorization
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let enviados = 0;
  let errores  = 0;

  try {
    const sheet = await getSheet("Recordatorios");
    const rows  = await sheet.getRows();
    const ahora = new Date();

    for (const row of rows) {
      // Saltar los ya enviados
      if (row.get("enviado") === "true") continue;

      const enviarEn = new Date(row.get("enviar_en"));

      // Saltar los que aún no corresponde enviar
      if (enviarEn > ahora) continue;

      try {
        await sendWhatsAppMessage(row.get("phone"), row.get("mensaje"));
        row.set("enviado", "true");
        row.set("enviado_en", ahora.toISOString());
        await row.save();
        enviados++;
      } catch (err) {
        console.error(`Error enviando recordatorio a ${row.get("phone")}:`, err.message);
        errores++;
      }
    }
  } catch (err) {
    console.error("Cron error:", err);
    return res.status(500).json({ error: err.message });
  }

  console.log(`Cron recordatorios: ${enviados} enviados, ${errores} errores`);
  res.status(200).json({ enviados, errores });
}
