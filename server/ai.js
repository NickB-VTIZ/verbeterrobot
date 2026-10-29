/**
 * ai.js — Verbetersleutel genereren via Omniroute (OpenAI-compatibel)
 * Optioneel met vakcontext (zie subjects.js) voor gerichter verbeteren.
 *
 * Geeft een array terug van { vraag, antwoord } objecten.
 */

import { getSettings } from "./settings.js";

/**
 * Vaste technische instructie die ALTIJD achter de (aanpasbare) systeemprompt komt.
 * De server verwerkt het bestand zelf; de AI levert enkel de antwoorden als JSON.
 * Zo blijft de uitvoer parseerbaar, ook als de systeemprompt in het beheer
 * een eigen werkwijze of didactische richtlijnen bevat.
 */
const OUTPUT_FORMAT = `

## TECHNISCH UITVOERFORMAAT (verplicht, heeft voorrang op alle andere instructies)
De verbeterrobot (de server) bewerkt het bestand zelf en plaatst jouw antwoorden in het document.
Jij hoeft dus GEEN bestanden te openen, aan te maken, om te zetten of aan te bieden, en je gebruikt geen tools.
Je krijgt de tekst van het document en antwoordt UITSLUITEND met een geldige JSON-array, zonder uitleg ervoor of erna en zonder Markdown-codefences:
[
  { "vraag": "<letterlijke vraagtekst of vraagnummer uit het document>", "antwoord": "<antwoord of berekening in tussenstappen>" }
]
- "vraag" moet letterlijk uit het document komen, zodat het antwoord bij de juiste vraag geplaatst kan worden.
- Meerdere stappen in "antwoord" scheid je met \\n. Gebruik geen dubbele aanhalingstekens binnen een tekst zonder ze te escapen.
- Geen samenvatting of andere tekst buiten de JSON-array. Zijn er geen vragen, antwoord dan met [].`;

/**
 * @param {string} documentText  Geëxtraheerde tekst van het document
 * @param {string} extraContext  Optionele extra instructies van de leerkracht
 * @param {string} subjectContext  Optionele vakcontext (vakprofiel) voor de systeemprompt
 * @returns {Promise<Array<{vraag: string, antwoord: string}>>}
 */
export async function getAnswersFromAI(documentText, extraContext = "", subjectContext = "") {
  const fetch = (await import("node-fetch")).default;
  // Instellingen worden bij elke aanvraag opnieuw gelezen (aanpasbaar in beheer)
  const cfg = getSettings();
  const BASE_URL = cfg.omnirouteBaseUrl;
  const API_KEY = cfg.omnirouteApiKey;
  const MODEL = cfg.omnirouteModel;
  const SYSTEM_PROMPT =
    (subjectContext ? `${cfg.systemPrompt}\n\n${subjectContext}` : cfg.systemPrompt) + OUTPUT_FORMAT;

  const userMessage = extraContext
    ? `Extra instructies van de leerkracht: ${extraContext}\n\n---\n\n${documentText}`
    : documentText;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: userMessage },
  ];

  async function ask() {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: cfg.temperature,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Omniroute API-fout (${response.status}): ${body.slice(0, 300)}`
      );
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
  }

  const raw = await ask();
  try {
    return parseAIResponse(raw);
  } catch (err) {
    if (!String(err.message).includes("geen geldige JSON")) throw err;
    // Eén nieuwe poging: vraag het model expliciet enkel de JSON-array te sturen
    messages.push({ role: "assistant", content: raw.slice(0, 4000) });
    messages.push({
      role: "user",
      content:
        "Dat was geen geldige JSON-array. Stuur NU enkel de JSON-array [{\"vraag\":\"...\",\"antwoord\":\"...\"}] " +
        "met alle vragen en antwoorden uit het document, zonder extra tekst en zonder codefences.",
    });
    const raw2 = await ask();
    return parseAIResponse(raw2);
  }
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
