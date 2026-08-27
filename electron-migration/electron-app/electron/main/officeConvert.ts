import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export interface OfficeArtifact {
  name: "soffice.js" | "soffice.data" | "soffice.wasm";
  url: string;
  sha256: string;
  contentType: string;
  brotli: boolean;
}

export const OFFICE_ARTIFACTS: readonly OfficeArtifact[] = [
  {
    name: "soffice.js",
    url: "https://cdn.zetaoffice.net/zetaoffice_latest/soffice.js",
    sha256: "5143e5354f470b87f86ba272bcfef857bd13e6f07b59666e48a7ccb89643cd77",
    contentType: "application/javascript",
    brotli: false,
  },
  {
    name: "soffice.data",
    url: "https://cdn.zetaoffice.net/zetaoffice_latest/soffice.data",
    sha256: "9d3c1cf3c904ce570905052ba6844f3383fde93ad1267b65a3ae4b236db2fd05",
    contentType: "application/octet-stream",
    brotli: true,
  },
  {
    name: "soffice.wasm",
    url: "https://cdn.zetaoffice.net/zetaoffice_latest/soffice.wasm",
    sha256: "a11808aaba3c9a4412a865bde645247fd9d0b262b5baa0680a9fced29a8656e4",
    contentType: "application/wasm",
    brotli: true,
  },
] as const;

export function officePdfFilter(extension: string): string {
  const ext = extension.toLocaleLowerCase().replace(/^.*(?=\.)/, "");
  if ([".ppt", ".pps", ".odp", ".pptx"].includes(ext)) return "impress_pdf_Export";
  if ([".xls", ".ods"].includes(ext)) return "calc_pdf_Export";
  return "writer_pdf_Export";
}

export function officeConvertible(name: string): boolean {
  return /\.(?:ppt|pps|odp|pptx|rtf|odt|doc|xls|ods)$/i.test(name);
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

async function downloadRaw(url: string, destination: string, redirects = 0): Promise<void> {
  if (redirects > 5) throw new Error("Too many office-converter download redirects.");
  await new Promise<void>((resolve, reject) => {
    const request = https.get(url, { headers: { "Accept-Encoding": "br" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        void downloadRaw(new URL(response.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Office-converter download returned HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }
      const output = fs.createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      response.on("error", reject);
      output.on("error", reject);
      output.on("finish", () => output.close(() => resolve()));
    });
    request.on("error", reject);
  });
}

export async function verifyOfficeArtifacts(directory: string): Promise<boolean> {
  for (const artifact of OFFICE_ARTIFACTS) {
    const filePath = path.join(directory, artifact.name);
    if (!fs.existsSync(filePath) || await fileSha256(filePath) !== artifact.sha256) return false;
  }
  return true;
}

/** Download only after the caller has shown and received explicit consent. */
export async function installOfficeArtifacts(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const artifact of OFFICE_ARTIFACTS) {
    const destination = path.join(directory, artifact.name);
    if (fs.existsSync(destination) && await fileSha256(destination) === artifact.sha256) continue;
    const partial = `${destination}.partial`;
    await fs.promises.rm(partial, { force: true });
    await downloadRaw(artifact.url, partial);
    if (await fileSha256(partial) !== artifact.sha256) {
      await fs.promises.rm(partial, { force: true });
      throw new Error(`The downloaded ${artifact.name} failed its integrity check.`);
    }
    await fs.promises.rename(partial, destination);
  }
}

type ElectronModule = typeof import("electron");

export class OfficeConverter {
  private server: http.Server | null = null;
  private window: import("electron").BrowserWindow | null = null;
  private electron: ElectronModule | null = null;
  private baseUrl = "";
  private chain: Promise<unknown> = Promise.resolve();
  private completedInWindow = 0;

  constructor(private readonly artifactDir: string) {}

  convert(name: string, bytes: Uint8Array): Promise<Buffer> {
    const task = this.chain.then(() => this.convertOne(name, bytes));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async boot(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return;
    this.electron = await import("electron");
    const rendererRoot = path.join(this.electron.app.getAppPath(), "dist_renderer", "office");
    this.server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      const artifact = OFFICE_ARTIFACTS.find((item) => requestUrl.pathname === `/artifacts/${item.name}`);
      const local = artifact
        ? path.join(this.artifactDir, artifact.name)
        : path.join(rendererRoot, requestUrl.pathname === "/" ? "converter.html" : requestUrl.pathname.replace(/^\//, ""));
      const root = artifact ? this.artifactDir : rendererRoot;
      if (!local.startsWith(`${root}${path.sep}`) || !fs.existsSync(local)) {
        response.writeHead(404).end();
        return;
      }
      if (artifact) {
        response.setHeader("Content-Type", artifact.contentType);
        if (artifact.brotli) response.setHeader("Content-Encoding", "br");
      } else if (local.endsWith(".html")) response.setHeader("Content-Type", "text/html; charset=utf-8");
      else response.setHeader("Content-Type", "application/javascript; charset=utf-8");
      fs.createReadStream(local).pipe(response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("The office converter could not bind its private server.");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.window = new this.electron.BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await this.window.loadURL(`${this.baseUrl}/converter.html?artifacts=${encodeURIComponent(`${this.baseUrl}/artifacts/`)}`);
    await this.window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.officeReady === true) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > 60000) { clearInterval(timer); reject(new Error('Office converter startup timed out.')); }
      }, 100);
    })`, true);
  }

  private async convertOne(name: string, bytes: Uint8Array): Promise<Buffer> {
    if (!officeConvertible(name)) throw new Error("This file type is not supported by the office converter.");
    await this.boot();
    const encodedName = JSON.stringify(name);
    const encodedBytes = JSON.stringify(Buffer.from(bytes).toString("base64"));
    const conversion = this.window!.webContents.executeJavaScript(
      `window.convertOfficeFile(${encodedName}, ${encodedBytes})`, true,
    ) as Promise<string>;
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Office conversion timed out after 60 seconds.")), 60_000,
      );
    });
    try {
      const base64 = await Promise.race([conversion, timeout]);
      const output = Buffer.from(base64, "base64");
      if (!output.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The converter did not produce a PDF.");
      this.completedInWindow += 1;
      if (this.completedInWindow >= 10) this.dispose();
      return output;
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  dispose(): void {
    this.window?.destroy();
    this.window = null;
    this.server?.close();
    this.server = null;
    this.completedInWindow = 0;
  }
}
