const modules = [
  ["money", "Integer-minor-unit money with currency"],
  ["domain", "Entity types"],
  ["engine", "Deterministic cash engine"],
  ["sandbox", "Fake bank, ledger and simulated counterparties"],
  ["gate", "Permission tiers and owner-signed limits"],
  ["actionlog", "Append-only action log"],
  ["agent", "Tool registry and agent loop"],
  ["ingest", "CSV import"],
  ["db", "Postgres schema"],
];

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-semibold">SME Finance Copilot</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Placeholder. FinTechathon 2026, Topic E. All data is synthetic.
      </p>
      <h2 className="mt-8 text-lg font-medium">Modules</h2>
      <ul className="mt-2 list-disc pl-5">
        {modules.map(([name, desc]) => (
          <li key={name}>
            <span className="font-mono">{name}</span>: {desc}
          </li>
        ))}
      </ul>
    </main>
  );
}
