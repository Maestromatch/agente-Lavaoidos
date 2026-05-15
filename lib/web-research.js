// lib/web-research.js
// Wrapper sobre Tavily Search API para que el agente pueda buscar info actual
// (estudios, artículos, recomendaciones técnicas) cuando responde dudas técnicas.

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * Busca en la web y devuelve un resumen breve listo para inyectar en la respuesta del agente.
 * @param {string} query - consulta en español.
 * @param {object} [opts]
 * @param {number} [opts.maxResults=3] - cuántos resultados traer (1-5).
 * @returns {Promise<{resumen: string, fuentes: Array<{title, url, snippet}>} | null>}
 */
export async function buscarWeb(query, { maxResults = 3 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("buscarWeb: TAVILY_API_KEY no configurada");
    return null;
  }

  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: Math.min(Math.max(maxResults, 1), 5),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Tavily error:", res.status, err);
      return null;
    }

    const data = await res.json();
    const fuentes = (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content?.slice(0, 280) || "",
    }));

    return {
      resumen: data.answer || fuentes[0]?.snippet || "Sin resumen disponible.",
      fuentes,
    };
  } catch (err) {
    console.error("buscarWeb error:", err.message);
    return null;
  }
}
