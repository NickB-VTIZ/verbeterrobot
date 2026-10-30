/** Gedeelde types en weergave-metadata voor het aanduiden (lijst- en documentweergave). */

export type Role = "vraag" | "antwoordplaats" | "gegeven" | "formuleblad" | "instructie" | "modelantwoord";

export interface Para {
  id: string;
  text: string;
  style: string | null;
  headingLevel: number | null;
  isList: boolean;
  bold: boolean;
  isEmpty: boolean;
  isPageBreak: boolean;
  inTable: boolean;
  tableCoord: { row: number; cell: number } | null;
  placeholders: number;
}

export interface Mark {
  paraId: string;
  role: Role;
  qid: string;
  subNr: string;
  slotType: string | null;
  slotCount: number | null;
  linkedParaIds: string[];
  teacherAnswer: string | null;
}

export const ROLE_META: Record<Role, { label: string; hint: string; bar: string; bg: string; active: string }> = {
  vraag: {
    label: "Vraag",
    hint: "Opgave of deelvraag",
    bar: "border-l-blue-500",
    bg: "bg-blue-50",
    active: "bg-blue-600 text-white border-blue-600",
  },
  antwoordplaats: {
    label: "Antwoordplaats",
    hint: "Hier komt het rode antwoord",
    bar: "border-l-red-500",
    bg: "bg-red-50",
    active: "bg-red-600 text-white border-red-600",
  },
  gegeven: {
    label: "Gegeven",
    hint: "Context, tekst, tabel bij een vraag",
    bar: "border-l-amber-500",
    bg: "bg-amber-50",
    active: "bg-amber-500 text-white border-amber-500",
  },
  formuleblad: {
    label: "Formuleblad",
    hint: "Referentie voor de AI",
    bar: "border-l-purple-500",
    bg: "bg-purple-50",
    active: "bg-purple-600 text-white border-purple-600",
  },
  instructie: {
    label: "Negeren",
    hint: "Titel of instructie, niets invullen",
    bar: "border-l-gray-400",
    bg: "bg-gray-100",
    active: "bg-gray-600 text-white border-gray-600",
  },
  modelantwoord: {
    label: "Modelantwoord",
    hint: "Antwoord dat al in het document staat",
    bar: "border-l-green-500",
    bg: "bg-green-50",
    active: "bg-green-600 text-white border-green-600",
  },
};

export const ROLE_ORDER: Role[] = ["vraag", "antwoordplaats", "gegeven", "formuleblad", "modelantwoord", "instructie"];

export const SLOT_LABEL: Record<string, string> = {
  fill_placeholders: "Invulpunten (…) in de tekst invullen",
  append: "Achter de tekst van deze regel",
  fill_empty_following: "In de lege regels eronder",
  insert_after: "Nieuwe regel eronder invoegen",
  fill_cell: "In deze (lege) tabelcel",
};

/** Korte omschrijving voor in de documentweergave. */
export const SLOT_SHORT: Record<string, string> = {
  fill_placeholders: "in de invulpunten",
  append: "achteraan deze regel",
  fill_empty_following: "in de lege regels eronder",
  insert_after: "op een nieuwe regel eronder",
  fill_cell: "in deze cel",
};
