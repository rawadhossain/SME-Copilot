// A template remounts on every navigation inside /room, so each view eases in once. The shell around it stays put.
export default function RoomTemplate({ children }: { children: React.ReactNode }) {
  return <div className="route-enter">{children}</div>;
}
