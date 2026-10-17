import View from "./View";

// The page loads its data from the API after sign-in (client-fetched), so dev-mode instant navigation validation is opted out.
export const instant = false;

export default function Page() {
  return <View />;
}
