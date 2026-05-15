# Otopía · Agente Lavaoídos

Asistente de WhatsApp para **Otopía**: servicio de operativos de lavado de oídos a domicilio o en empresa en la Región Metropolitana de Chile. Atención por fonoaudiólogo certificado, $15.000 CLP por paciente, reserva vía WhatsApp.

## Stack

- **Runtime:** Node.js 20 (ESM) en Vercel Serverless
- **Mensajería:** WhatsApp Cloud API (Meta)
- **IA:** Claude API (Sonnet)
- **Base de datos:** Google Sheets (vía Service Account)
- **Pagos:** Mercadopago
- **Cron:** Vercel Cron Jobs

Detalles de arquitectura, flujo y backlog en [`CLAUDE.md`](./CLAUDE.md). Schema de las hojas en [`docs/sheets-schema.md`](./docs/sheets-schema.md).

---

## Setup local

```bash
git clone <repo>
cd agente-lavaoidos
npm install
cp .env.example .env.local
# editar .env.local con las credenciales reales
npm run dev
```

`vercel dev` levanta el server en `http://localhost:3000`. Para que Meta llegue al webhook necesitas exponer el puerto con `ngrok http 3000` y registrar la URL pública en la app de WhatsApp Business.

---

## Deploy a Vercel

```bash
vercel link              # primera vez, conectar al proyecto
vercel env pull          # bajar las env vars de Vercel a .env.local
npm run deploy           # vercel --prod
```

**Variables de entorno** deben configurarse en el dashboard de Vercel (Settings → Environment Variables). Ver `.env.example` para la lista.

---

## Configurar WhatsApp (Meta Cloud API)

1. Crear app en [developers.facebook.com](https://developers.facebook.com) → producto **WhatsApp Business**.
2. Obtener `PHONE_NUMBER_ID` y un **System User token permanente**.
3. En la sección Webhooks:
   - URL: `https://<tu-dominio-vercel>/api/webhook`
   - Verify token: el mismo valor que pongas en `WHATSAPP_VERIFY_TOKEN`
   - Suscribir al campo `messages`

---

## Configurar Mercadopago

1. Crear app en [mercadopago.com.cl/developers](https://www.mercadopago.com.cl/developers).
2. Copiar el **Access Token de producción** a `MERCADOPAGO_ACCESS_TOKEN`.
3. En la app, configurar el webhook:
   - URL: `https://<tu-dominio-vercel>/api/payment-webhook`
   - Evento: **Pagos** (`payment`)

---

## Configurar Google Sheets

1. Crear spreadsheet con las 4 hojas: `Operativos`, `Conversaciones`, `Reservas`, `Recordatorios` (ver columnas en [`docs/sheets-schema.md`](./docs/sheets-schema.md)).
2. En Google Cloud Console:
   - Crear un **Service Account**.
   - Generar una key JSON.
   - Habilitar la **Google Sheets API**.
3. Compartir el spreadsheet con el email del service account (`xxxx@xxxx.iam.gserviceaccount.com`) con permiso **Editor**.
4. Copiar el `client_email` y `private_key` del JSON a `.env.local`.
5. Copiar el `SHEET_ID` de la URL.

---

## Estructura

```
agente-lavaoidos/
├── api/
│   ├── webhook.js              ← Webhook de WhatsApp (entrada del agente)
│   ├── payment-webhook.js      ← Webhook de Mercadopago
│   └── cron-reminders.js       ← Cron cada 30 min
├── lib/
│   ├── whatsapp.js
│   ├── mercadopago.js
│   └── sheets.js
├── public/
│   ├── index.html              ← Landing
│   └── pago-*.html
├── docs/
└── CLAUDE.md
```
