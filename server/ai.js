/**
 * ai.js — Verbetersleutel genereren via Omniroute (OpenAI-compatibel)
 *
 * Geeft een array terug van { vraag, antwoord } objecten.
 */

import { getSettings } from "./settings.js";

/**
 * @param {string} documentText  Geëxtraheerde tekst van het document
 * @param {string} extraContext  Optionele extra instructies van de leerkracht
 * @returns {Promise<Array<{vraag: string, antwoord: string}>>}
 */
export async function getAnswersFromAI(documentText, extraContext = "") {
  const fetch = (await import("node-fetch")).default;
  // Instellingen worden bij elke aanvraag opnieuw gelezen (aanpasbaar in beheer)
  const cfg = getSettings();
  const BASE_URL = cfg.omnirouteBaseUrl;
  const API_KEY = cfg.omnirouteApiKey;
  const MODEL = cfg.omnirouteModel;
  const SYSTEM_PROMPT = cfg.systemPrompt;

  const userMessage = extraContext
    ? `Extra instructies van de leerkracht: ${extraContext}\n\n---\n\n${documentText}`
    : documentText;

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: cfg.temperature,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Omniroute API-fout (${response.status}): ${body.slice(0, 300)}`
    );
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";

  return parseAIResponse(raw);
}

/**
 * Parset de JSON-array uit de AI-response.
 * Probeert ook te herstellen als de AI per ongeluk code-fences toevoegde.
 *
 * @param {string} raw
 * @returns {Array<{vraag: string, antwoord: string}>}
 */
function parseAIResponse(raw) {
  // Verwijder mogelijke ```json ... ``` wrappers
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Zoek het eerste '[' en het laatste ']' en probeer die te parsen
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        throw new Error(
          "AI stuurde geen geldige JSON terug. Probeer het opnieuw of gebruik een ander model."
        );
      }
    } else {
      throw new Error(
        "AI stuurde geen geldige JSON terug. Probeer het opnieuw of gebruik een ander model."
      );
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AI-antwoord is geen array van vragen en antwoorden.");
  }

  // Valideer en filter ongeldige entries
  return parsed
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.vraag === "string" &&
        typeof item.antwoord === "string" &&
        item.vraag.trim().length > 0 &&
        item.antwoord.trim().length > 0
    )
    .map((item) => ({
      vraag: item.vraag.trim(),
      antwoord: item.antwoord.trim(),
    }));
}
