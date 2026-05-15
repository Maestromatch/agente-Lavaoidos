// lib/validators.js
// Validaciones de datos de entrada del paciente.

// ── RUT chileno (algoritmo módulo 11) ─────────────────────────────────────────
// Acepta formatos: "12.345.678-5", "12345678-5", "123456785".
// Devuelve { valido: bool, normalizado?: "12345678-5", motivo?: string }

export function validarRut(rutInput) {
  if (!rutInput || typeof rutInput !== "string") {
    return { valido: false, motivo: "vacío" };
  }

  // Limpiar: quitar puntos, guiones y espacios. Pasar a mayúscula (por la K).
  const limpio = rutInput.replace(/[.\-\s]/g, "").toUpperCase();

  if (limpio.length < 8 || limpio.length > 9) {
    return { valido: false, motivo: "largo inválido" };
  }

  const cuerpo = limpio.slice(0, -1);
  const dv = limpio.slice(-1);

  if (!/^\d+$/.test(cuerpo)) {
    return { valido: false, motivo: "cuerpo no numérico" };
  }
  if (!/^[0-9K]$/.test(dv)) {
    return { valido: false, motivo: "dv inválido" };
  }

  // Cálculo módulo 11
  let suma = 0;
  let multiplicador = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * multiplicador;
    multiplicador = multiplicador === 7 ? 2 : multiplicador + 1;
  }

  const resto = 11 - (suma % 11);
  const dvCalculado =
    resto === 11 ? "0" : resto === 10 ? "K" : String(resto);

  if (dv !== dvCalculado) {
    return { valido: false, motivo: "dígito verificador no coincide" };
  }

  return {
    valido: true,
    normalizado: `${cuerpo}-${dv}`,
  };
}

// ── Teléfono chileno ──────────────────────────────────────────────────────────
// Móvil chileno: 9 dígitos empezando con 9, o 11 dígitos con código país 56.
// Devuelve { valido: bool, normalizado?: "569XXXXXXXX" (formato WhatsApp), motivo?: string }

export function validarTelefonoCL(phoneInput) {
  if (!phoneInput || typeof phoneInput !== "string") {
    return { valido: false, motivo: "vacío" };
  }

  // Quitar +, espacios, paréntesis, guiones
  const limpio = phoneInput.replace(/[\s+\-()]/g, "");

  if (!/^\d+$/.test(limpio)) {
    return { valido: false, motivo: "caracteres no numéricos" };
  }

  // Caso 1: 9 dígitos empezando con 9 (formato local: 9XXXXXXXX)
  if (limpio.length === 9 && limpio.startsWith("9")) {
    return { valido: true, normalizado: `56${limpio}` };
  }

  // Caso 2: 11 dígitos con código país (569XXXXXXXX)
  if (limpio.length === 11 && limpio.startsWith("569")) {
    return { valido: true, normalizado: limpio };
  }

  return { valido: false, motivo: "formato no es móvil chileno" };
}
