# Agente Lavaoídos — Guía para Claude Code

Asistente de WhatsApp que agenda y cobra cupos en operativos de lavado de oídos en la Región Metropolitana (Chile). Toda nueva sesión de Claude Code debe leer este archivo antes de tocar código.

---

## Arquitectura

**Stack:** Node.js 20 (ESM) · Vercel Serverless + Cron · Google Sheets como BD · WhatsApp Cloud API (Meta) · Claude API (Sonnet) · Mercadopago.

**Flujo end-to-end:**

1. Paciente escribe a WhatsApp → Meta llama a `POST /api/webhook`
2. `api/webhook.js` carga conversación previa (sheet `Conversaciones`), agrega mensaje del usuario, llama a Claude con system prompt + historial
3. Claude responde con texto + (opcionalmente) una acción `[ACTION:CREAR_RESERVA|...]`
4. Si hay acción de reserva → `lib/mercadopago.createPaymentLink()` + insertar en sheet `Reservas` (estado `pendiente_pago`)
5. Paciente paga → Mercadopago llama a `POST /api/payment-webhook`
6. Webhook confirma reserva, descuenta cupo en sheet `Operativos`, envía confirmación al paciente y al admin, agenda recordatorios
7. Cada 30 min, `api/cron-reminders.js` revisa sheet `Recordatorios` y envía los que vencieron

**Por qué Google Sheets:** Permite a la dueña del negocio editar operativos sin tocar código. Para escalar más allá de ~500 reservas/mes, migrar a Supabase (Fase 4.3 del backlog).

---

## Estructura de carpetas

```
agente-lavaoidos/
├── api/
│   ├── webhook.js              ← WhatsApp + agente Claude
│   ├── payment-webhook.js      ← Webhook de Mercadopago
│   └── cron-reminders.js       ← Cron cada 30 min
├── lib/
│   ├── whatsapp.js             ← sendWhatsAppMessage, markAsRead
│   ├── mercadopago.js          ← createPaymentLink
│   └── sheets.js               ← Capa de acceso a Google Sheets
├── public/
│   ├── index.html              ← Landing pública (CTA a wa.me)
│   ├── pago-exitoso.html
│   ├── pago-fallido.html
│   ├── pago-pendiente.html
│   └── privacy-policy.html
├── docs/
│   ├── sheets-schema.md        ← Columnas exactas de cada hoja
│   └── fases-original.txt      ← Plan original (referencia)
├── .env.local                  ← Secrets reales (gitignored)
├── .env.example                ← Plantilla
├── package.json
├── vercel.json
└── CLAUDE.md                   ← Este archivo
```

---

## Variables de entorno

Todas se configuran en Vercel (production) y en `.env.local` (dev). Ver `.env.example` para la lista completa.

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | Llamadas a Claude. |
| `WHATSAPP_PHONE_ID` / `WHATSAPP_TOKEN` | Cloud API de Meta. Token permanente. |
| `WHATSAPP_VERIFY_TOKEN` | Validación inicial del webhook. |
| `ADMIN_PHONE` | Número que recibe notificación de cada reserva. |
| `MERCADOPAGO_ACCESS_TOKEN` | Crea preferencias de pago y consulta status. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` | Auth a Google Sheets. |
| `GOOGLE_SHEET_ID` | ID del spreadsheet (de la URL). |
| `APP_URL` | URL base para callbacks/back_urls. |
| `CRON_SECRET` | Auth del cron de Vercel. |

---

## Reglas de negocio (que el agente debe respetar)

- Solo se cobra online vía Mercadopago. **No se aceptan transferencias.**
- Duración por paciente: 15–20 min. Apto para niños, adultos y adultos mayores.
- **Contraindicación:** perforación timpánica → derivar al otorrino, no agendar.
- Tono: cálido, profesional, español chileno natural, máx 4 líneas por mensaje, 1–2 emojis.
- Link de pago expira en 24h.
- Recordatorios: 48h y 2h antes de la cita.
- Cancelaciones: pedir al menos 24h de anticipación.

---

## Backlog priorizado

Plan completo en `docs/fases-original.txt`. Orden recomendado por impacto/esfuerzo:

### 🔴 Fase 1 — Solidez (en curso)
1. **Validación de RUT chileno** (dígito verificador) en `webhook.js` antes de crear reserva
2. **Lista de espera**: nueva hoja `ListaEspera`, lógica cuando el operativo está lleno, notificación al liberarse cupo
3. **Flujo de cancelaciones**: detectar intento, liberar cupo, instrucciones de reembolso, log en Sheets
4. **Timeout de sesión**: limpiar `step` y `history` si pasaron 24h sin respuesta
5. **Rate limiting**: máx N mensajes por número por ventana de tiempo
6. **Detección de contraindicaciones**: screening explícito antes de confirmar

### 🟡 Fase 2 — Experiencia
- Saludar por nombre si el número ya reservó antes
- Confirmar/cancelar desde el recordatorio ("responde CONFIRMO")
- Enviar imagen/mapa con ubicación al confirmar
- Pedir reseña post-servicio

### 🟢 Fase 3 — Panel admin
- `/public/admin.html` con auth básica: reservas del día, pagos, cupos
- CRUD de operativos sin tocar Sheets
- Broadcast a pacientes de un operativo
- Métricas: conversión, operativos top, tasa de cancelación

### Fase 4 — Escala
- Multi-localidad
- Notificación automática a lista de espera
- Migrar de Sheets a Supabase
- Streaming de Claude + fallback si falla

### Fase 5 — Producto
- Multi-tenant (varias clínicas)
- App admin mobile (PWA)
- Integración Google Calendar
- Fidelización / referidos

---

## Reglas para Claude Code en este proyecto

- **Idioma:** Responder al usuario en español.
- **Secrets:** Nunca commitear `.env.local` ni los JSON de credenciales. Verificar siempre con `git status` antes de commitear.
- **Editar Sheets:** Toda lectura/escritura debe pasar por `lib/sheets.js`. No duplicar el helper de auth en cada archivo.
- **Mensajes WhatsApp:** Toda salida debe pasar por `lib/whatsapp.js`.
- **Prompts del agente:** El system prompt vive en `api/webhook.js`. Cambios al tono o reglas → editar ahí.
- **Acciones:** El protocolo `[ACTION:TIPO|param:valor|...]` es la única forma en que Claude dispara efectos. Documentar nuevas acciones aquí cuando se agreguen.
- **Validaciones:** Nuevas validaciones (RUT, teléfono) → módulo nuevo en `lib/validators.js`, no inline en `webhook.js`.
- **Deploy:** `npm run deploy` (Vercel CLI). Antes de pushear: verificar que `.env.local` no esté en stage.

---

## Setup local rápido

```bash
cd agente-lavaoidos
npm install
cp .env.example .env.local   # rellenar valores reales
npm run dev                   # vercel dev
```

Para probar el webhook localmente sin exponer el puerto, usar `ngrok http 3000` y registrar la URL temporal en Meta.

Schema completo de las hojas → `docs/sheets-schema.md`.
