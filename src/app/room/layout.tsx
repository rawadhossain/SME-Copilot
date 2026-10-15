import { Shell } from "@/ui/Shell";

export const metadata = { title: "Decision room · Ledgerhand" };

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
