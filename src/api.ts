// Gedeelde fetch-hulpjes voor bibliotheek, detail, markeren en beheer.
// Alle aanroepen sturen de Bearer-token mee; een 401 meldt de sessie als verlopen.

export type JsonInit = Omit<RequestInit, "body"> & { body?: any };

export interface Api {
  json: <T = any>(url: string, init?: JsonInit) => Promise<T>;
  blob: (url: string) => Promise<Blob>;
  download: (url: string, fallbackName: string) => Promise<void>;
  token: string;
}

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function createApi(token: string, onUnauthorized: () => void): Api {
  const auth = { Authorization: `Bearer ${token}` };

  async function raw(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    if (res.status === 401) {
      onUnauthorized();
      throw new ApiError("Sessie verlopen.", 401);
    }
    return res;
  }

  async function json<T = any>(url: string, init: JsonInit = {}): Promise<T> {
    const headers: Record<string, string> = {};
    let body = init.body;
    if (body !== undefined && body !== null && !(body instanceof FormData) && typeof body !== "string") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await raw(url, { ...init, body, headers: { ...headers, ...(init.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || data.message || `Serverfout (${res.status})`, res.status, data);
    return data as T;
  }

  async function blob(url: string): Promise<Blob> {
    const res = await raw(url);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new ApiError(d.error || `Serverfout (${res.status})`, res.status, d);
    }
    return res.blob();
  }

  async function download(url: string, fallbackName: string): Promise<void> {
    const res = await raw(url);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new ApiError(d.error || `Serverfout (${res.status})`, res.status, d);
    }
    let name = fallbackName;
    const cd = res.headers.get("Content-Disposition") || "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    try {
      if (star) name = decodeURIComponent(star[1]);
      else if (plain) name = plain[1];
    } catch {
      /* standaardnaam blijft */
    }
    const b = await res.blob();
    saveBlob(b, name);
  }

  return { json, blob, download, token };
}

export function saveBlob(b: Blob, name: string) {
  const u = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

export function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("nl-BE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const STATUS_LABEL: Record<string, string> = {
  geupload: "Geüpload",
  aangeduid: "Aangeduid",
  bezig: "Bezig…",
  gegenereerd: "Gegenereerd",
  goedgekeurd: "Goedgekeurd",
  mislukt: "Mislukt",
};

export const STATUS_TONE: Record<string, string> = {
  geupload: "bg-gray-100 text-gray-700",
  aangeduid: "bg-blue-100 text-blue-800",
  bezig: "bg-amber-100 text-amber-800",
  gegenereerd: "bg-indigo-100 text-indigo-800",
  goedgekeurd: "bg-green-100 text-green-800",
  mislukt: "bg-red-100 text-red-800",
};

export interface DocItem {
  id: string;
  title: string;
  originalFilename: string;
  teacher: string;
  vak: string;
  vakId: string;
  leerjaar: string;
  richting: string;
  schooljaar: string;
  tags: string[];
  status: string;
  activeVersion: number | null;
  previewStatus: string;
  note: string;
  genOptions: any;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  versionCount?: number;
  thumbFileId?: string | null;
  keyThumbFileId?: string | null;
  originalFileId?: string | null;
  originalPdfFileId?: string | null;
  originalThumbFileId?: string | null;
  bytes?: number;
}
