import { useEffect, useState } from "react";

interface UserItem {
  id: string;
  username: string;
  displayName: string;
  role: "teacher" | "admin";
  active: boolean;
  createdAt: string;
  lastLogin: string | null;
}

interface Props {
  token: string;
  onUnauthorized: () => void;
}

const inputCls =
  "w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent";
const labelCls = "block text-sm font-medium text-gray-700 mb-1.5";
const hintCls = "text-xs text-gray-400 mt-1";

const ROLE_LABEL: Record<UserItem["role"], string> = { teacher: "Leerkracht", admin: "Beheerder" };

function fmt(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("nl-BE", { dateStyle: "short", timeStyle: "short" });
}

export default function UsersAdmin({ token, onUnauthorized }: Props) {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserItem["role"]>("teacher");

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const auth = { Authorization: `Bearer ${token}` };
  const json = { ...auth, "Content-Type": "application/json" };

  async function call(url: string, init: RequestInit = {}) {
    const res = await fetch(url, init);
    if (res.status === 401 || res.status === 403) {
      onUnauthorized();
      throw new Error("Sessie verlopen.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Serverfout (${res.status})`);
    return data;
  }

  async function reload() {
    const d = await call("/api/admin/users", { headers: auth });
    setUsers(d.users || []);
  }

  useEffect(() => {
    reload().catch(e => setMsg({ type: "err", text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ type: "ok", text });
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Mislukt." });
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    run(async () => {
      await call("/api/admin/users", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, displayName, password, role }),
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      await reload();
      return "Gebruiker aangemaakt.";
    });

  const patch = (u: UserItem, body: Record<string, unknown>, okText: string) =>
    run(async () => {
      await call(`/api/admin/users/${u.id}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
      await reload();
      return okText;
    });

  const resetPassword = (u: UserItem) => {
    const pw = prompt(`Nieuw wachtwoord voor ${u.displayName} (minstens 8 tekens):`);
    if (!pw) return;
    patch(u, { password: pw }, "Wachtwoord gewijzigd. De gebruiker is afgemeld.");
  };

  const remove = (u: UserItem) => {
    if (!confirm(`Gebruiker "${u.username}" verwijderen? Documenten blijven bestaan.`)) return;
    run(async () => {
      await call(`/api/admin/users/${u.id}`, { method: "DELETE", headers: auth });
      await reload();
      return "Gebruiker verwijderd.";
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-gray-900">Gebruikers</h3>
        <p className="text-xs text-gray-500 mt-1">
          Maak persoonlijke accounts met gebruikersnaam en wachtwoord. De &ldquo;weergavenaam&rdquo; wordt
          gebruikt als naam van de leerkracht bij documenten: leerkrachten zien enkel hun eigen documenten.
          Het gedeelde wachtwoord (onder Instellingen) blijft werken.
        </p>
      </div>

      {msg && (
        <div
          className={`rounded-lg px-4 py-3 text-sm border ${
            msg.type === "ok"
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      <fieldset className="space-y-3" disabled={busy}>
        <legend className="text-sm font-semibold text-gray-800">Nieuwe gebruiker</legend>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Gebruikersnaam</label>
            <input
              className={inputCls}
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="off"
              placeholder="bv. jan.peeters"
            />
          </div>
          <div>
            <label className={labelCls}>Weergavenaam</label>
            <input
              className={inputCls}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoComplete="off"
              placeholder="bv. Jan Peeters"
            />
          </div>
          <div>
            <label className={labelCls}>Wachtwoord</label>
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className={hintCls}>Minstens 8 tekens.</p>
          </div>
          <div>
            <label className={labelCls}>Rol</label>
            <select className={inputCls} value={role} onChange={e => setRole(e.target.value as UserItem["role"])}>
              <option value="teacher">Leerkracht</option>
              <option value="admin">Beheerder</option>
            </select>
          </div>
        </div>
        <button
          type="button"
          className="btn-primary cursor-pointer"
          disabled={busy || !username.trim() || !displayName.trim() || password.length < 8}
          onClick={create}
        >
          Gebruiker aanmaken
        </button>
      </fieldset>

      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-800">Bestaande gebruikers ({users.length})</h4>
        {users.length === 0 && <p className="text-sm text-gray-500">Nog geen persoonlijke accounts.</p>}
        {users.map(u => (
          <div
            key={u.id}
            className="rounded-lg border border-gray-200 px-4 py-3 text-sm flex flex-wrap items-center gap-3"
          >
            <div className="min-w-[12rem] flex-1">
              <div className="font-medium text-gray-900">
                {u.displayName}{" "}
                <span className="text-gray-400 font-normal">({u.username})</span>
              </div>
              <div className="text-xs text-gray-500">
                {ROLE_LABEL[u.role]} · aangemaakt {fmt(u.createdAt)} · laatste login {fmt(u.lastLogin)}
              </div>
            </div>
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                u.active ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
              }`}
            >
              {u.active ? "actief" : "uitgeschakeld"}
            </span>
            <select
              className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
              value={u.role}
              disabled={busy}
              onChange={e => patch(u, { role: e.target.value }, "Rol gewijzigd.")}
              aria-label="Rol"
            >
              <option value="teacher">Leerkracht</option>
              <option value="admin">Beheerder</option>
            </select>
            <button
              type="button"
              className="text-xs text-gray-700 underline cursor-pointer"
              disabled={busy}
              onClick={() => resetPassword(u)}
            >
              Wachtwoord wijzigen
            </button>
            <button
              type="button"
              className="text-xs text-gray-700 underline cursor-pointer"
              disabled={busy}
              onClick={() =>
                patch(u, { active: !u.active }, u.active ? "Gebruiker uitgeschakeld." : "Gebruiker geactiveerd.")
              }
            >
              {u.active ? "Uitschakelen" : "Activeren"}
            </button>
            <button
              type="button"
              className="text-xs text-red-700 underline cursor-pointer"
              disabled={busy}
              onClick={() => remove(u)}
            >
              Verwijderen
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
