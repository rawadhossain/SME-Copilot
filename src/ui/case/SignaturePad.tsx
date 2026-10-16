"use client";
// A signature, two ways. DRAW: the owner draws with a mouse, finger or pen. TYPE: the owner types their full name and it is rendered in a handwriting
// style (fully usable from the keyboard and with a screen reader). Either way the result is a PNG (transparent background, dark ink) that is sent with
// the password when signing; the server stores it and its fingerprint becomes part of the signed record. It is a visible mark of intent, not stronger
// authentication than the password.
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Field, inputClass } from "../kit";

const W = 600;
const H = 180;
const INK = "#16201e";
const SCRIPT = "italic 62px 'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Snell Roundhand', cursive";

/** Renders a typed name as a signature image. */
function typedPng(name: string): string {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = INK; g.font = SCRIPT; g.textBaseline = "middle"; g.textAlign = "center";
  // Shrink long names to fit the page.
  let size = 62;
  while (size > 24 && g.measureText(name).width > W - 60) { size -= 4; g.font = SCRIPT.replace("62px", `${size}px`); }
  g.fillText(name, W / 2, H / 2 - 8);
  g.strokeStyle = INK; g.lineWidth = 1.6; g.beginPath(); g.moveTo(40, H - 42); g.lineTo(W - 40, H - 42); g.stroke();
  return c.toDataURL("image/png");
}

export function SignaturePad({ onChange, name }: { onChange: (dataUrl: string | null) => void; name: string }) {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const ink = useRef(0);
  const [hasInk, setHasInk] = useState(false);
  const [typed, setTyped] = useState("");

  const ctx = useCallback(() => {
    const c = ref.current?.getContext("2d");
    if (c) { c.lineWidth = 2.6; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = INK; }
    return c ?? null;
  }, []);
  useEffect(() => { ctx(); }, [ctx, mode]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const c = ctx();
    if (c && last.current) { c.beginPath(); c.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2); c.fillStyle = INK; c.fill(); }
    ink.current += 2;
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const p = point(e);
    const c = ctx();
    if (!c) return;
    // Smooth the stroke through the midpoint of each segment.
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    c.beginPath(); c.moveTo(last.current.x, last.current.y); c.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y); c.lineTo(p.x, p.y); c.stroke();
    ink.current += Math.hypot(p.x - last.current.x, p.y - last.current.y);
    last.current = p;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false; last.current = null;
    if (ink.current > 60) { setHasInk(true); onChange(ref.current!.toDataURL("image/png")); }
  };
  const clear = () => {
    const c = ref.current?.getContext("2d");
    c?.clearRect(0, 0, W, H);
    ink.current = 0; setHasInk(false); onChange(null);
  };
  const switchTo = (m: "draw" | "type") => { if (m !== mode) { setMode(m); setHasInk(false); setTyped(""); ink.current = 0; onChange(null); } };
  const typedName = typed.trim();

  return (
    <div>
      <div role="tablist" aria-label="How to sign" className="mb-2 flex gap-2">
        {(["draw", "type"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => switchTo(m)} className={`rounded-lg border px-3 py-1 text-sm ${mode === m ? "border-accent bg-accent-soft font-medium text-accent" : "border-line hover:bg-neutral-soft"}`}>
            {m === "draw" ? "Draw it" : "Type it (keyboard)"}
          </button>
        ))}
      </div>

      {mode === "draw" ? (
        <>
          <div className="relative rounded-xl border border-line-strong bg-white">
            <canvas
              ref={ref} width={W} height={H} role="img" aria-label={`Signature pad. Draw the signature of ${name} with a mouse, finger or pen. If you cannot draw, use the Type it tab.`}
              className="block w-full touch-none cursor-crosshair rounded-xl"
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
            />
            {!hasInk && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-soft">Sign here</span>}
            <span className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-line-strong" aria-hidden />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-ink-soft">
            <span>{hasInk ? `Signed as ${name}` : "Draw your signature above"}</span>
            <Btn variant="ghost" onClick={clear} disabled={!hasInk}>Clear</Btn>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Field label="Type your full name as your signature">
            <input
              className={inputClass} value={typed} autoComplete="off" maxLength={60} placeholder={name}
              onChange={(e) => { setTyped(e.target.value); const v = e.target.value.trim(); onChange(v.length >= 3 ? typedPng(v) : null); }}
            />
          </Field>
          <div className="flex min-h-[7rem] items-center justify-center rounded-xl border border-line-strong bg-white px-4" aria-live="polite">
            {typedName.length >= 3 ? <span style={{ font: SCRIPT, color: INK, fontSize: typedName.length > 22 ? "34px" : "52px" }}>{typedName}</span> : <span className="text-sm text-ink-soft">Your typed signature appears here</span>}
          </div>
          <p className="text-xs text-ink-soft">{typedName.length >= 3 ? `Signed as ${name}` : "Type at least three characters."}</p>
        </div>
      )}
    </div>
  );
}
