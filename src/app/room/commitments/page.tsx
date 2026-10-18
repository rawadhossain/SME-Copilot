import View from "./View";

// Dev-mode instant-navigation validation cannot see a client-fetched page; opt out (the page loads its data from the API).
export const instant = false;
export const metadata = { title: "Orders & quotes" };

export default function Page() {
  return <View />;
}
