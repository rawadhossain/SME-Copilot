// Demo and developer tools (fresh demo copies, sample documents, the /dev page). On by default in development; OFF in a production build
// unless DEMO_TOOLS=on. DEMO_TOOLS=off turns them off everywhere. Owners never see them in a production deployment.
export const demoToolsEnabled = (): boolean => process.env.DEMO_TOOLS === "on" || (process.env.NODE_ENV !== "production" && process.env.DEMO_TOOLS !== "off");
