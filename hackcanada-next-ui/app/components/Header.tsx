export function Header({ view, onAbort }: { view: "input" | "diagnostic"; onAbort: () => void }) {
  return (
    <header className="shrink-0 flex items-end justify-between px-8 pt-8 pb-5 border-b-2 border-black bg-white/80 backdrop-blur-sm sticky top-0 z-10">
      <div className="flex items-baseline gap-4">
        <h1 
          className="text-4xl sm:text-5xl font-black tracking-tighter leading-none cursor-pointer hover:text-brand transition-colors" 
          onClick={onAbort}
        >
          Opera AI
        </h1>
        <span className="font-mono text-xs tracking-widest text-brand font-bold uppercase hidden sm:inline-block">
          {view === "input" ? "Hardware Diagnostic Engine" : "Active Repair Sequence"}
        </span>
      </div>
      {view === "diagnostic" && (
        <button onClick={onAbort} className="font-mono text-xs font-bold uppercase tracking-widest text-black/50 hover:text-black">
          [ RESTART ]
        </button>
      )}
    </header>
  );
}