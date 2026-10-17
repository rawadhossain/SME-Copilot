// A tiny Chrome DevTools Protocol driver for the committed browser test. No dependency: it needs a Chromium-based browser already installed
// (Edge, Chrome or Chromium; set BROWSER_PATH to choose one) and the WebSocket built into Bun and Node 22+. It starts the browser headless with a
// throwaway profile and an automatic debugging port, and stops only the process it started, by PID.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.BROWSER_PATH ?? "",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
];

export const findBrowser = (): string | null => CANDIDATES.find((p) => p && existsSync(p)) ?? null;

export class Page {
  private id = 0;
  private pending = new Map<number, (d: { result?: unknown; error?: unknown }) => void>();
  constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id && this.pending.has(d.id)) { this.pending.get(d.id)!(d); this.pending.delete(d.id); }
    };
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve, reject) => {
      const i = ++this.id;
      this.pending.set(i, (d) => (d.error ? reject(new Error(`${method}: ${JSON.stringify(d.error)}`)) : resolve(d.result as T)));
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  viewport(width: number, height: number, mobile = false) { return this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile }); }
  async goto(url: string) { await this.send("Page.navigate", { url }); await this.sleep(400); }
  async eval<T = any>(expression: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page error: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value as T;
  }
  /** Polls a page expression until it is truthy. Throws with the current page text on timeout, so a failure explains itself. */
  async waitFor(expression: string, what: string, timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try { if (await this.eval(`!!(${expression})`)) return; } catch { /* page navigating */ }
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Page text: ${(await this.text().catch(() => "")).slice(0, 1800).replace(/\s+/g, " ")}`);
      await this.sleep(250);
    }
  }
  text(): Promise<string> { return this.eval("document.body.innerText"); }
  waitText(snippet: string, timeoutMs = 60_000) { return this.waitFor(`document.body.innerText.includes(${JSON.stringify(snippet)})`, `text "${snippet}"`, timeoutMs); }
  /** Clicks the nth VISIBLE element (button, link, tab or summary) whose text starts with `text`. */
  async click(text: string, nth = 0, selector = "button,a,summary,[role=tab]"): Promise<void> {
    // A few quick retries: the dev server can reload the page under us (hot reload) between a wait and the click.
    let ok = false;
    for (let attempt = 0; attempt < 8 && !ok; attempt++) {
      if (attempt > 0) await this.sleep(500);
      try {
        ok = await this.eval<boolean>(`(()=>{const v=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';const els=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>v(e)&&!e.disabled&&(e.innerText||'').trim().startsWith(${JSON.stringify(text)}));const e=els[${nth}];if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`);
      } catch { /* the page was navigating */ }
    }
    if (!ok) throw new Error(`No visible, enabled "${text}" (#${nth}) to click. Page text: ${(await this.text()).slice(0, 500).replace(/\s+/g, " ")} | state: ${await this.eval<string>("document.readyState + ' ' + location.href + ' ' + innerWidth + 'x' + innerHeight + ' ' + document.body.outerHTML.slice(0, 200)").catch(() => "?")}`);
  }
  /** Sets a React-controlled input the way a user typing would (native setter plus an input event). */
  async type(selector: string, value: string): Promise<void> {
    const ok = await this.eval<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    if (!ok) throw new Error(`No input matches ${selector}`);
  }
  /** Presses Tab n times and returns what has focus each time (tag, name and whether a focus outline is drawn). */
  async tabThrough(n: number): Promise<{ tag: string; name: string; outline: boolean }[]> {
    const out = [];
    for (let i = 0; i < n; i++) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      out.push(await this.eval<{ tag: string; name: string; outline: boolean }>(`(()=>{const e=document.activeElement;const s=getComputedStyle(e);return {tag:e.tagName,name:(e.getAttribute('aria-label')||e.innerText||e.value||'').trim().slice(0,40),outline:s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0}})()`));
    }
    return out;
  }
  overflow(): Promise<number> { return this.eval("document.documentElement.scrollWidth - document.documentElement.clientWidth"); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

export class Browser {
  private constructor(private proc: ChildProcess, private port: number, private profile: string) {}
  static async launch(): Promise<Browser | null> {
    const exe = findBrowser();
    if (!exe) return null;
    const profile = mkdtempSync(join(tmpdir(), "sme-browser-"));
    const proc = spawn(exe, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
    const file = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 80 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 250));
    if (!existsSync(file)) { proc.kill(); throw new Error("The browser did not open a debugging port"); }
    return new Browser(proc, Number(readFileSync(file, "utf8").split("\n")[0]), profile);
  }
  async newPage(): Promise<Page> {
    const t = (await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = () => r(null); ws.onerror = () => j(new Error("cannot connect to the page")); });
    const p = new Page(ws);
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    // A background tab pauses requestAnimationFrame, which React streaming uses to reveal the page: keep this one focused and visible.
    await p.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    await p.send("Page.bringToFront").catch(() => undefined);
    return p;
  }
  close() {
    if (this.proc.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"]);
      else this.proc.kill();
    }
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* the profile may still be locked; it is in the temp folder */ }
  }
}
