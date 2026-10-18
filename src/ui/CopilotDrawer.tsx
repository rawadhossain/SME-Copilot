"use client";
// The header "Ask" button on every /room page: opens the same Copilot in a native dialog drawer, so the owner can talk from anywhere.
// The conversation stays in the drawer while the page changes; the dialog closes on Escape or on the Close button.
import { useRef, useState } from "react";
import { Btn } from "./kit";
import { Copilot } from "./Copilot";

export function CopilotDrawer() {
  const ref = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Btn variant="secondary" onClick={() => { setOpened(true); ref.current?.showModal(); }}>Ask</Btn>
      <dialog ref={ref} aria-label="Ask Copilot" className="fixed inset-y-0 right-0 left-auto m-0 h-screen max-h-screen w-[28rem] max-w-full overflow-y-auto border-l border-line bg-panel p-5 text-ink shadow-2xl backdrop:bg-black/30" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="display text-lg">Ask Copilot</h2>
          <button type="button" className="rounded-lg border border-line-strong px-3 py-1 text-sm" onClick={() => ref.current?.close()}>Close</button>
        </div>
        {opened && <Copilot autoFocus />}
      </dialog>
    </>
  );
}
