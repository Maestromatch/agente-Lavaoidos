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
| `step` | string | `inicio`, `mostro_operativos`, `eligio`, `validando_rut`, `esperando_pago`, `en_lista_espera`. |
| `ultimo_mensaje` | datetime | ISO 8601. |
| `motivo_pedido` | boolean | `true` si el cron de re-engagement ya le preguntó qué lo frenó (evita repreguntar). |

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

## Hoja: `Objeciones`

Motivos de no-reserva categorizados. El cron-engagement pregunta a conversaciones abandonadas qué los frenó; cuando responden, el agente categoriza con Claude y registra acá. El reporte semanal lo usa para mostrar top objeciones.

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | string | Identificador. |
| `categoria` | string | Una de: `precio`, `tiempo`, `confianza`, `ubicacion`, `indecision`, `contraindicacion`, `otro`. |
| `texto_original` | string | Lo que escribió el lead, sin categorizar. |
| `paso_en_que_quedo` | string | Step en que estaba la conversación al abandonar. |
| `creado_en` | datetime | ISO 8601. |

---

## Hoja: `Leads`

Personas que llegaron vía Meta Lead Ads u otros canales con opt-in pero que aún no escribieron al WhatsApp por su cuenta. El cron-engagement las usa para outbound proactivo dentro de las reglas de Meta.

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | string | Número en formato 56XXXXXXXXX (validado). Llave única. |
| `nombre` | string | Nombre dado en el formulario. |
| `comuna` | string | Para matchear con operativos nuevos por zona. |
| `opt_in` | boolean | `true` solo si dio consentimiento explícito (es requisito Meta para outbound). |
| `origen_ad` | string | `ad_id` o `form_id` que originó al lead. |
| `form_id` | string | ID del formulario de Lead Ads. |
| `estado` | string | `nuevo`, `contactado`, `en_conversacion`, `convertido`, `descartado`. |
| `notificado` | boolean | `true` si el cron ya le envió una notificación. |
| `creado_en` | datetime | ISO 8601. |
| `notificado_en` | datetime | ISO 8601. |
| `ultima_actividad` | datetime | Actualizado al recibir mensajes o re-submits del form. |

---

## Hoja: `ListaEspera`

Pacientes que no pudieron reservar porque (a) el operativo elegido estaba lleno, (b) no había operativo disponible o (c) no hay operativo cerca de su comuna. El cron de re-engagement (Fase 3.2) los notifica cuando se cumple la condición.

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | string | Identificador del lead. |
| `nombre` | string | Nombre que dio. |
| `comuna` | string | Comuna del paciente (para emparejar con operativos nuevos por zona). |
| `operativo_id_deseado` | string | FK opcional a `Operativos.id`. Vacío si solo quiere ser notificado de operativos futuros. |
| `motivo` | string | `cupo_agotado`, `sin_operativos`, `fuera_de_zona`. |
| `notificado` | boolean | `true` cuando ya se le avisó. |
| `creado_en` | datetime | ISO 8601. |
| `notificado_en` | datetime | ISO 8601, al notificar. |

**Triggers de notificación (futuro Fase 3.2):**
- Cancelación de reserva en `motivo=cupo_agotado` + mismo `operativo_id_deseado` → template `cupo_liberado`.
- Operativo nuevo cargado cuya comuna matchea → template `nuevo_operativo_zona`.

---

## Hoja: `FAQ`

Respuestas validadas que el agente puede inyectar al system prompt cuando detecta keywords en el mensaje del paciente. Permite ajustar el comportamiento sin redeployar.

| Columna | Tipo | Ejemplo | Notas |
|---|---|---|---|
| `pregunta` | string | `¿El lavado de oídos duele?` | Solo para humanos; el agente no la usa para matchear. |
| `keywords` | string | `duele,dolor,molesta,molestia` | Lista separada por comas (case-insensitive). El agente busca si alguna keyword (mín 3 caracteres) aparece en el mensaje del paciente. |
| `respuesta` | string | `No, el procedimiento es indoloro. Algunos sienten una leve presión por el agua tibia, nada más.` | La inyecta al system prompt como "información validada". |
| `activo` | boolean | `TRUE` | `TRUE`/`FALSE`. Si `FALSE`, no se considera. |

**Reglas:**
- Solo se inyectan máximo **3 matches** por mensaje (para no inflar el prompt).
- Keywords de menos de 3 caracteres se ignoran (`a`, `no`, etc.).
- Cuando una respuesta se valida y se sube a la hoja, queda disponible de inmediato sin redeploy.

**Ejemplos sugeridos:**
- `¿Duele?` → keywords: `duele,dolor,molesta`
- `¿Tienen estacionamiento?` → keywords: `estacionamiento,parking,auto`
- `¿Atienden niños?` → keywords: `niño,niña,hijo,hija,bebé`
- `¿Cómo me preparo?` → keywords: `preparo,preparación,antes,ayuno`
- `¿Aceptan tarjeta?` → keywords: `tarjeta,visa,master,débito,crédito`
- `¿Hacen reembolso?` → keywords: `reembolso,devolución,cancelar pago`

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
