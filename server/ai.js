/**
 * ai.js — Verbetersleutel genereren via Omniroute (OpenAI-compatibel)
 *
 * Geeft een array terug van { vraag, antwoord } objecten.
 */

const BASE_URL = process.env.OMNIROUTE_BASE_URL || "https://omniroute.example.com/v1";
const API_KEY  = process.env.OMNIROUTE_API_KEY  || "";
const MODEL    = process.env.OMNIROUTE_MODEL    || "gpt-4o";

const SYSTEM_PROMPT = `Je bent een ervaren leerkracht die een verbetersleutel opstelt.
Je krijgt de volledige tekst van een taak of toets.
Identificeer ALLE vragen (genummerd, geletterd, bullet of als zin geformuleerd).
Los elke vraag correct en volledig op.

Stuur je antwoord als een JSON-array, ZONDER Markdown-codefences, in dit formaat:
[
  { "vraag": "<letterlijke vraag of vraagnummer>", "antwoord": "<correct antwoord>" },
  ...
]

Regels:
- Gebruik dezelfde taal als het document.
- Wees beknopt maar volledig.
- Als een vraag meerdere deelvragen heeft, geef dan een antwoord per deelvraag als aparte objecten.
- Verzin geen vragen die er niet zijn.
- Als er geen vragen zijn, geef dan een lege array [].`;

/**
 * @param {string} documentText  Geëxtraheerde tekst van het document
 * @param {string} extraContext  Optionele extra instructies van de leerkracht
 * @returns {Promise<Array<{vraag: string, antwoord: string}>>}
 */
export async function getAnswersFromAI(documentText, extraContext = "") {
  const fetch = (await import("node-fetch")).default;

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
      temperature: 0.2,
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
