"use client";
// A handwritten-signature pad: the owner draws with a mouse, finger or pen. The drawing is exported as a PNG (transparent background, dark ink) and is
// sent with the password when signing; the server stores it and its fingerprint becomes part of the signed record. It is a visible mark of intent, not
// stronger authentication than the password.
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn } from "../kit";

const W = 600;
const H = 180;

export function SignaturePad({ onChange, name }: { onChange: (dataUrl: string | null) => void; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const ink = useRef(0);
  const [hasInk, setHasInk] = useState(false);

  const ctx = useCallback(() => {
    const c = ref.current?.getContext("2d");
    if (c) { c.lineWidth = 2.6; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#16201e"; }
    return c ?? null;
  }, []);
  useEffect(() => { ctx(); }, [ctx]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const c = ctx();
    if (c && last.current) { c.beginPath(); c.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2); c.fillStyle = "#16201e"; c.fill(); }
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

  return (
    <div>
      <div className="relative rounded-xl border border-line-strong bg-white">
        <canvas
          ref={ref} width={W} height={H} role="img" aria-label={`Signature pad. Draw the signature of ${name} with a mouse, finger or pen.`}
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
    </div>
  );
}
