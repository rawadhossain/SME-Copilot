"use client";
// The "Ask Copilot" button on every /room page, and the drawer it opens: the same Copilot, available from anywhere. Other screens open it with
// askCopilot("question") (see Copilot.tsx), which sends that question straight away. The conversation stays while the page changes.
import { useEffect, useRef, useState } from "react";
import { Btn } from "./kit";
import { Icon } from "./icons";
import { Copilot } from "./Copilot";

export function CopilotDrawer() {
  const ref = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [seed, setSeed] = useState({ message: "", n: 0 });

  function open(message?: string) {
    setOpened(true);
    if (message) setSeed((s) => ({ message, n: s.n + 1 }));
    if (!ref.current?.open) ref.current?.showModal();
  }
  useEffect(() => {
    const on = (e: Event) => open((e as CustomEvent<{ message?: string }>).detail?.message);
    window.addEventListener("open-copilot", on);
    return () => window.removeEventListener("open-copilot", on);
  }, []);

  return (
    <>
      <Btn variant="secondary" className="!h-9 !px-3.5" onClick={() => open()}><Icon name="ask" size={16} />Ask Copilot</Btn>
      {/* padding lives on the inner blocks: the global dialog reset would beat a utility class on the dialog itself */}
      <dialog ref={ref} aria-label="Ask Copilot" className="drawer fixed inset-y-0 right-0 left-auto m-0 h-screen max-h-screen w-[27rem] max-w-full overflow-hidden text-ink" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <div><h2 className="display text-[17px]">Ask Copilot</h2><p className="text-xs text-ink-soft">Reads your books. Cannot pay, sign or send.</p></div>
            <button type="button" aria-label="Close" className="press rounded-lg p-1.5 text-ink-soft hover:bg-neutral-soft hover:text-ink" onClick={() => ref.current?.close()}><Icon name="close" size={16} /></button>
          </div>
          <div className="min-h-0 flex-1">{opened && <Copilot autoFocus seed={seed} />}</div>
        </div>
      </dialog>
    </>
  );
}
