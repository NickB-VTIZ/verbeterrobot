import { useEffect, useState } from "react";

// ── Robot-mascotte met stemmingen ─────────────────────────────────────
export type Mood = "idle" | "thinking" | "happy" | "sad";

const THINKING_SYMBOLS = ["∑", "π", "Ω", "⚡", "%", "√", "η", "?"];
const HAPPY_SYMBOLS = ["✨", "🎉", "⭐", "✔", "✨", "🎊"];

function FloatingSymbols({ symbols }: { symbols: string[] }) {
  return (
    <div className="absolute inset-x-0 top-0 h-0 pointer-events-none" aria-hidden="true">
      {symbols.map((s, i) => (
        <span
          key={i}
          className="symbol-rise absolute text-red-500 font-bold text-sm select-none"
          style={{
            left: `${18 + ((i * 13) % 64)}%`,
            animationDelay: `${i * 0.55}s`,
            ["--dx" as string]: `${(i % 2 === 0 ? -1 : 1) * (6 + i * 3)}px`,
          }}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

export function RobotMascot({ mood = "idle", className = "" }: { mood?: Mood; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      {mood === "thinking" && <FloatingSymbols symbols={THINKING_SYMBOLS} />}
      {mood === "happy" && <FloatingSymbols symbols={HAPPY_SYMBOLS} />}

      <svg
        viewBox="0 0 96 104"
        className={`robot robot-${mood} w-full h-full text-red-600`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Verbeterrobot"
      >
        {/* Lichaam */}
        <rect x="26" y="72" width="44" height="26" rx="8" fill="#fee2e2" stroke="currentColor" strokeWidth="3" />
        <circle className="robot-heart" cx="48" cy="85" r="4.5" fill="currentColor" />
        {/* Linkerarm */}
        <line x1="26" y1="78" x2="14" y2="90" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        {/* Rechterarm */}
        {mood === "thinking" ? (
          <line x1="70" y1="78" x2="76" y2="62" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        ) : (
          <line
            className={mood === "happy" ? "robot-arm-wave" : ""}
            x1="70" y1="78" x2="82" y2="90"
            stroke="currentColor" strokeWidth="4" strokeLinecap="round"
          />
        )}

        {/* Hoofd */}
        <g className="robot-head">
          {/* Antenne */}
          <line x1="48" y1="10" x2="48" y2="24" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle className="robot-antenna" cx="48" cy="8" r="5" fill="currentColor" />
          {/* Oren */}
          <rect x="9" y="38" width="9" height="16" rx="3" fill="currentColor" opacity="0.85" />
          <rect x="78" y="38" width="9" height="16" rx="3" fill="currentColor" opacity="0.85" />
          {/* Gezicht */}
          <rect x="18" y="24" width="60" height="46" rx="13" fill="#ffffff" stroke="currentColor" strokeWidth="3" />

          {/* Ogen */}
          <g className="robot-look">
            {mood === "happy" ? (
              <>
                <path d="M29 46 Q36 36 43 46" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                <path d="M53 46 Q60 36 67 46" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </>
            ) : (
              <g className="robot-eyes">
                <ellipse cx="36" cy="45" rx="6.5" ry="7.5" fill="currentColor" />
                <ellipse cx="60" cy="45" rx="6.5" ry="7.5" fill="currentColor" />
                <circle cx="38" cy="42.5" r="2" fill="#ffffff" />
                <circle cx="62" cy="42.5" r="2" fill="#ffffff" />
              </g>
            )}
          </g>
          {mood === "sad" && (
            <>
              <line x1="28" y1="33" x2="42" y2="37" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              <line x1="68" y1="33" x2="54" y2="37" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </>
          )}
          {mood === "thinking" && (
            <line x1="52" y1="32" x2="68" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          )}

          {/* Mond */}
          {mood === "happy" && (
            <path d="M36 56 Q48 70 60 56 Z" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          )}
          {mood === "idle" && (
            <path d="M38 58 Q48 65 58 58" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          )}
          {mood === "thinking" && (
            <path className="robot-mouth-think" d="M40 61 q4 -4 8 0 t8 0" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          )}
          {mood === "sad" && (
            <path d="M38 63 Q48 54 58 63" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          )}
        </g>
      </svg>
    </div>
  );
}

// ── Denkballon: wisselt automatisch van tekst ─────────────────────────
export function ThoughtBubble({
  messages,
  interval = 3400,
  thinking = false,
}: {
  messages: string[];
  interval?: number;
  thinking?: boolean;
}) {
  const [i, setI] = useState(0);
  const key = messages.join("|");

  useEffect(() => {
    setI(0);
    if (messages.length < 2) return;
    const t = setInterval(() => setI(p => (p + 1) % messages.length), interval);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interval]);

  const text = messages.length ? messages[i % messages.length] : "";

  return (
    <div className="relative flex-1 min-w-0" role="status" aria-live="polite">
      {/* Denkbolletjes richting de robot */}
      <span className="absolute -left-3 top-1/2 w-3 h-3 rounded-full bg-white border-2 border-red-200" aria-hidden="true" />
      <span className="absolute -left-6 top-[68%] w-2 h-2 rounded-full bg-white border-2 border-red-200" aria-hidden="true" />

      <div
        key={`${key}-${i}`}
        className="bubble-pop bg-white border-2 border-red-200 rounded-2xl px-4 py-3 text-sm text-gray-700 shadow-sm min-h-[3.25rem] flex items-center gap-2"
      >
        <span className="leading-snug">{text}</span>
        {thinking && (
          <span className="inline-flex gap-1 shrink-0" aria-hidden="true">
            <span className="dot-bounce w-1.5 h-1.5 rounded-full bg-red-400" style={{ animationDelay: "0s" }} />
            <span className="dot-bounce w-1.5 h-1.5 rounded-full bg-red-400" style={{ animationDelay: "0.15s" }} />
            <span className="dot-bounce w-1.5 h-1.5 rounded-full bg-red-400" style={{ animationDelay: "0.3s" }} />
          </span>
        )}
      </div>
    </div>
  );
}

// ── Workflow-balk: Upload → Vak → AI denkt → Rode sleutel ─────────────
const WORKFLOW = [
  { icon: "📄", label: "Upload" },
  { icon: "🎓", label: "Vak & onderwerp" },
  { icon: "🤔", label: "AI denkt na" },
  { icon: "🖍️", label: "Rode sleutel" },
];

/** active: 1..4 = huidige stap, 5 = alles klaar */
export function WorkflowSteps({ active }: { active: number }) {
  return (
    <ol className="flex items-start w-full" aria-label="Werkwijze">
      {WORKFLOW.map((s, idx) => {
        const n = idx + 1;
        const done = active > n;
        const current = active === n;
        return (
          <li key={s.label} className="flex-1 flex flex-col items-center relative">
            {idx > 0 && (
              <span
                className={`absolute top-4 right-1/2 w-full h-0.5 -z-0 transition-colors duration-500 ${
                  active >= n ? "bg-red-300" : "bg-gray-200"
                }`}
                aria-hidden="true"
              />
            )}
            <span
              className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-sm border-2 transition-all duration-300 ${
                done
                  ? "bg-green-500 border-green-500 text-white"
                  : current
                  ? "bg-white border-red-500 step-pulse scale-110"
                  : "bg-white border-gray-200 grayscale opacity-60"
              }`}
            >
              {done ? "✓" : s.icon}
            </span>
            <span
              className={`mt-1 text-[11px] text-center leading-tight ${
                current ? "text-red-700 font-semibold" : done ? "text-gray-500" : "text-gray-400"
              }`}
            >
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── "Zo stel ik mijn opdracht samen": bouwstenen van de prompt ────────
export interface PromptParts {
  hasFile: boolean;
  subject?: string;
  topicCount: number;
  hasContext: boolean;
}

export function PromptBlocks({ parts }: { parts: PromptParts }) {
  const blocks = [
    { icon: "⚙️", label: "Vaste regels (beheer)", on: true },
    { icon: "📄", label: "Document", on: parts.hasFile },
    { icon: "🎓", label: parts.subject ? `Vak: ${parts.subject}` : "Vak", on: !!parts.subject },
    {
      icon: "🏷️",
      label: parts.topicCount ? `${parts.topicCount} onderwerp${parts.topicCount > 1 ? "pen" : ""}` : "Onderwerpen",
      on: parts.topicCount > 0,
    },
    { icon: "💬", label: "Extra instructies", on: parts.hasContext },
  ];

  return (
    <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3">
      <p className="text-xs font-medium text-gray-500 mb-2">Zo stel ik mijn opdracht samen</p>
      <div className="flex flex-wrap gap-1.5">
        {blocks.map(b => (
          <span
            key={b.label}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs border transition-all duration-300 ${
              b.on
                ? "bg-red-50 border-red-300 text-red-700 font-medium chip-on"
                : "bg-white border-dashed border-gray-300 text-gray-400"
            }`}
          >
            <span aria-hidden="true">{b.icon}</span>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}
