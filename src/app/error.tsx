"use client";
// Shown when a screen fails to render. No technical details are shown to the user.
import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6 text-center">
      <div>
        <h1 className="display text-3xl">Something went wrong</h1>
        <p className="mt-2 text-ink-soft">Nothing was changed by this error. Try again, and if it keeps happening, sign out and back in.</p>
        {error.digest && <p className="mt-3 text-xs text-ink-soft">Reference: {error.digest}</p>}
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" onClick={reset} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">Try again</button>
          <a href="/room" className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium">Back to Today</a>
        </div>
      </div>
    </main>
  );
}
