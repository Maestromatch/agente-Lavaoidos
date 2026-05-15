# Templates de WhatsApp para subir a Meta

Estas 3 plantillas son **necesarias** para que el agente pueda enviar mensajes proactivos fuera de la ventana de 24h (recordatorios de operativos, notificaciones de cupos, re-engagement).

**Cómo subirlas:**
1. Ve a [business.facebook.com](https://business.facebook.com) → tu cuenta → **WhatsApp Manager**.
2. **Plantillas de mensaje** → **Crear plantilla**.
3. Para cada plantilla de abajo:
   - Pegá el **nombre exacto** (snake_case, en inglés/español sin acentos)
   - Seleccioná la **categoría** indicada
   - Idioma: **Español (CL)** o **Español**
   - Pegá el body con las variables `{{1}}`, `{{2}}`, etc.
   - Agregá los **ejemplos de muestra** (Meta los pide para aprobar)
4. Enviar a aprobación. Demora **24-48h**. Te llega notificación.

⚠️ **Reglas críticas:**
- No usar tono comercial agresivo ("OFERTA EXCLUSIVA", "ÚLTIMA OPORTUNIDAD"). Meta rechaza.
- Si la categoría es Marketing, el usuario debe haber dado opt-in (formulario, landing, click-to-chat). En el spreadsheet llevar columna `opt_in: true/false`.
- Las plantillas Utility (recordatorios, confirmaciones) tienen menos fricción.

---

## 1. `recordatorio_operativo_proximo`

**Categoría:** Marketing
**Idioma:** Español
**Uso:** Re-engagement con leads que escribieron en últimos 7-14 días pero no reservaron, cuando hay un operativo próximo.

**Header (opcional):** Texto — `Operativo de Lavado de Oídos`

**Body:**
```
Hola {{1}} 👋

Tenemos operativo {{2}} en {{3}}. Quedan {{4}} cupos disponibles.

¿Te gustaría reservar tu cupo? Responde este mensaje y te ayudamos al instante.
```

**Footer (opcional):** `Para no recibir más, responde STOP.`

**Botones (opcionales):**
- Quick Reply: `Quiero reservar`
- Quick Reply: `Ver detalles`

**Ejemplos de muestra para Meta:**
- `{{1}}` = `María`
- `{{2}}` = `el sábado 24 de mayo`
- `{{3}}` = `Centro Comunitario Ñuñoa`
- `{{4}}` = `8`

---

## 2. `nuevo_operativo_zona`

**Categoría:** Marketing
**Idioma:** Español
**Uso:** Notificar a leads cuando se carga un operativo nuevo cerca de su comuna (declarada en conversación previa).

**Body:**
```
Hola {{1}} 👋

Buenas noticias: hay un nuevo operativo de lavado de oídos cerca de tu zona.

📅 {{2}}
📍 {{3}}
💰 ${{4}}

Si te interesa, responde este mensaje y reservamos tu cupo.
```

**Ejemplos de muestra:**
- `{{1}}` = `Carlos`
- `{{2}}` = `Domingo 1 de junio, 10:00`
- `{{3}}` = `Plaza Las Condes`
- `{{4}}` = `15.000`

---

## 3. `cupo_liberado`

**Categoría:** Utility
**Idioma:** Español
**Uso:** Avisar a un lead en lista de espera que se liberó cupo por cancelación. **Categoría Utility** porque es respuesta a una solicitud previa del lead (anotarse en espera).

**Body:**
```
Hola {{1}} 👋

Se liberó un cupo en el operativo que estabas esperando:

📅 {{2}} a las {{3}}
📍 {{4}}

El cupo se reserva al primero que responda. Si lo quieres, responde este mensaje en los próximos 60 minutos.
```

**Ejemplos de muestra:**
- `{{1}}` = `Andrea`
- `{{2}}` = `15 de junio`
- `{{3}}` = `11:30`
- `{{4}}` = `Maipú`

---

## Después de la aprobación

Cuando las 3 plantillas estén aprobadas, avisame con sus nombres exactos y las integro en `lib/templates.js` y en el cron de re-engagement (`api/cron-engagement.js`).

El env var `WHATSAPP_TEMPLATE_LANGUAGE` debe estar en `.env.local` con el código del idioma usado al subir (usualmente `es` o `es_CL`).
