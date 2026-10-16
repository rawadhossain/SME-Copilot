export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg place-items-center px-6 text-center">
      <div>
        <h1 className="display text-3xl">Page not found</h1>
        <p className="mt-2 text-ink-soft">That page does not exist, or you do not have access to it.</p>
        <a href="/room" className="mt-6 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">Back to Today</a>
      </div>
    </main>
  );
}
