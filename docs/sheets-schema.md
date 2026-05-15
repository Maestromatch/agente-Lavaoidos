# Google Sheets — Esquema de hojas

El proyecto usa un único spreadsheet (variable `GOOGLE_SHEET_ID`) con 4 hojas. Los nombres de las hojas y de las columnas son **case-sensitive** y deben coincidir exactamente.

---

## Hoja: `Operativos`

Fuente de verdad de los operativos disponibles. El agente lee de aquí los cupos.

| Columna | Tipo | Ejemplo | Notas |
|---|---|---|---|
| `id` | string | `OP-2026-05-20-NUNOA` | ID único. Usado en reservas y para descontar cupos. |
| `lugar` | string | `Centro Comunitario Ñuñoa` | Nombre visible para el paciente. |
| `fecha` | date | `2026-05-20` | Formato ISO `YYYY-MM-DD`. |
| `hora` | time | `09:00` | Formato 24h `HH:MM`. |
| `direccion` | string | `Av. Irarrázaval 1234, Ñuñoa` | Visible para el paciente. |
| `precio` | number | `15000` | Pesos chilenos sin separadores. |
| `cupos_disponibles` | number | `30` | El cron de pago lo decrementa al confirmar. |
| `activo` | boolean | `TRUE` | `TRUE`/`FALSE`. Si `FALSE`, no se muestra. |

---

## Hoja: `Conversaciones`

Estado por número de teléfono. Permite que el agente sea stateless (Vercel) usando Sheets como memoria.

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | string | Número con código país, sin `+` (`56968171774`). Llave. |
| `history` | string (JSON) | Array de mensajes `[{"role":"user","content":"..."}]`. Máx 20. |
| `step` | string | `inicio`, `eligiendo`, `confirmar`, `esperando_pago`. |
| `ultimo_mensaje` | datetime | ISO 8601. |

---

## Hoja: `Reservas`

Registro de reservas (pendientes y confirmadas).

| Columna | Tipo | Notas |
|---|---|---|
| `id` | string | `RES-{timestamp}` |
| `phone` | string | Número del paciente. |
| `nombre` | string | Nombre completo. |
| `rut` | string | RUT chileno. |
| `operativo_id` | string | FK a `Operativos.id`. |
| `operativo_lugar` | string | Snapshot del lugar al momento de reservar. |
| `operativo_fecha` | date | Snapshot. |
| `operativo_hora` | time | Snapshot. |
| `operativo_direccion` | string | Snapshot. |
| `precio` | number | Snapshot del precio cobrado. |
| `estado` | string | `pendiente_pago` → `confirmada` / `cancelada` / `expirada`. |
| `link_pago` | string | URL de Mercadopago. |
| `payment_id` | string | ID de pago de Mercadopago (al confirmar). |
| `creado_en` | datetime | ISO 8601. |
| `confirmado_en` | datetime | ISO 8601, al recibir webhook de pago. |

---

## Hoja: `Funnel`

Cada evento de conversión se registra como una fila. Permite calcular tasas de conversión por etapa, detectar abandonos, y analizar comportamiento por operativo.

Eventos posibles (columna `evento`):
- `primer_msg` — paciente escribe por primera vez
- `mostro_operativos` — el agente envió el catálogo
- `eligio_operativo` — el paciente eligió uno (reservado para futuro)
- `dio_datos` — paciente completó nombre + RUT
- `recibio_link` — el agente generó link de pago
- `pago_completado` — webhook MP confirmó el pago
- `conversacion_abandonada` — 24h sin respuesta (cron futuro)

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | string | Identifica al lead. |
| `evento` | string | Uno de los valores listados arriba. |
| `timestamp` | datetime | ISO 8601 del momento del evento. |
| `metadata` | string (JSON) | Datos extra del evento (ej: operativo_id, monto, texto). |

**Cálculos típicos:**
- Conversión total = `count(pago_completado) / count(primer_msg)`
- Drop-off por etapa = `count(etapa_N) - count(etapa_N+1)` para cada etapa secuencial
- Tiempo promedio de cierre = `avg(timestamp(pago_completado) - timestamp(primer_msg))` por phone

---

## Hoja: `Recordatorios`

Cola de recordatorios programados. El cron `/api/cron-reminders` corre cada 30 min y envía los que ya vencieron.

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | string | Destinatario. |
| `nombre` | string | Para personalizar el mensaje. |
| `tipo` | string | `48h` o `2h`. |
| `enviar_en` | datetime | ISO 8601. Cron compara contra `Date.now()`. |
| `fecha` | date | De la cita. |
| `hora` | time | De la cita. |
| `lugar` | string | De la cita. |
| `direccion` | string | De la cita. |
| `mensaje` | string | Texto pre-renderizado a enviar. |
| `enviado` | boolean | `true`/`false`. Pasa a `true` al enviarse. |
| `enviado_en` | datetime | ISO 8601, al enviarse. |

---

## Cómo crear el spreadsheet

1. Crea un Google Sheet nuevo en la cuenta que controla el negocio.
2. Crea las 4 hojas con los nombres exactos: `Operativos`, `Conversaciones`, `Reservas`, `Recordatorios`.
3. En la fila 1 de cada hoja, escribe los nombres de columna **idénticos** a la tabla de arriba.
4. Comparte el spreadsheet con el email del Service Account (`GOOGLE_SERVICE_ACCOUNT_EMAIL`) con permiso **Editor**.
5. Copia el `SHEET_ID` desde la URL (`docs.google.com/spreadsheets/d/<SHEET_ID>/edit`) y ponlo en `.env.local` y en las variables de Vercel.
