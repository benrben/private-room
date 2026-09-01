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
      receiveOfficeDownload(response, url, destination, redirects, resolve, reject);
    });
    request.on("error", reject);
  });
}

export function officeDownloadRedirect(response: http.IncomingMessage, sourceUrl: string): string | null {
  const { statusCode } = response;
  const location = response.headers.location;
  if (!statusCode || statusCode < 300 || statusCode >= 400 || !location) return null;
  return new URL(location, sourceUrl).toString();
}

type OfficeArtifactDownload = (url: string, destination: string, redirects?: number) => Promise<void>;

/** The installer keeps its I/O behind this small seam so the integrity rules
 * can be verified without fetching a converter or touching the host disk. */
export interface OfficeArtifactInstallerDeps {
  join(directory: string, name: string): string;
  exists(filePath: string): boolean;
  mkdir(directory: string): Promise<void>;
  remove(filePath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  sha256(filePath: string): Promise<string>;
  download: OfficeArtifactDownload;
}

const defaultOfficeArtifactInstallerDeps: OfficeArtifactInstallerDeps = {
  join: path.join,
  exists: fs.existsSync,
  mkdir: async (directory) => {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  },
  remove: async (filePath) => {
    await fs.promises.rm(filePath, { force: true });
  },
  rename: fs.promises.rename,
  sha256: fileSha256,
  download: downloadRaw,
};

export type OfficeDownloadOutput = NodeJS.WritableStream & {
  close(callback: () => void): unknown;
};

type OfficeOutputFactory = (destination: string) => OfficeDownloadOutput;

function createOfficeDownloadOutput(destination: string): OfficeDownloadOutput {
  return fs.createWriteStream(destination, { mode: 0o600 });
}

export function receiveOfficeDownload(
  response: http.IncomingMessage,
  sourceUrl: string,
  destination: string,
  redirects: number,
  resolve: () => void,
  reject: (reason: unknown) => void,
  download: OfficeArtifactDownload = downloadRaw,
  createOutput: OfficeOutputFactory = createOfficeDownloadOutput,
): void {
  const redirectUrl = officeDownloadRedirect(response, sourceUrl);
  if (redirectUrl) {
    response.resume();
    void download(redirectUrl, destination, redirects + 1).then(resolve, reject);
    return;
  }
  if (response.statusCode !== 200) {
    response.resume();
    reject(new Error(`Office-converter download returned HTTP ${response.statusCode ?? "unknown"}.`));
    return;
  }
  const output = createOutput(destination);
  response.pipe(output);
  response.on("error", reject);
  output.on("error", reject);
  output.on("finish", () => output.close(resolve));
}

export async function verifyOfficeArtifacts(directory: string): Promise<boolean> {
  for (const artifact of OFFICE_ARTIFACTS) {
    const filePath = path.join(directory, artifact.name);
    if (!fs.existsSync(filePath) || await fileSha256(filePath) !== artifact.sha256) return false;
  }
  return true;
}

/** Download only after the caller has shown and received explicit consent. */
export async function installOfficeArtifacts(
  directory: string,
  deps: OfficeArtifactInstallerDeps = defaultOfficeArtifactInstallerDeps,
): Promise<void> {
  await deps.mkdir(directory);
  for (const artifact of OFFICE_ARTIFACTS) {
    const destination = deps.join(directory, artifact.name);
    if (deps.exists(destination) && await deps.sha256(destination) === artifact.sha256) continue;
    const partial = `${destination}.partial`;
    await deps.remove(partial);
    await deps.download(artifact.url, partial);
    if (await deps.sha256(partial) !== artifact.sha256) {
      await deps.remove(partial);
      throw new Error(`The downloaded ${artifact.name} failed its integrity check.`);
    }
    await deps.rename(partial, destination);
  }
}

type ElectronModule = typeof import("electron");

export interface OfficeConverterRuntime {
  loadElectron(): Promise<ElectronModule>;
  createServer: typeof http.createServer;
}

const defaultOfficeConverterRuntime: OfficeConverterRuntime = {
  loadElectron: () => import("electron"),
  createServer: http.createServer,
};

export interface OfficeServerFile {
  artifact: OfficeArtifact | undefined;
  localPath: string;
}

export interface OfficeHeaderResponse {
  setHeader(name: string, value: string): void;
}

export interface OfficeConverterFiles {
  fileExists(filePath: string): boolean;
  openReadStream(filePath: string): { pipe(destination: http.ServerResponse): unknown };
}

const defaultOfficeConverterFiles: OfficeConverterFiles = {
  fileExists: fs.existsSync,
  openReadStream: fs.createReadStream,
};

function officeArtifactForPath(pathname: string): OfficeArtifact | undefined {
  return OFFICE_ARTIFACTS.find((item) => pathname === `/artifacts/${item.name}`);
}

function officeServerPath(
  artifact: OfficeArtifact | undefined,
  artifactDir: string,
  rendererRoot: string,
  pathname: string,
): string {
  if (artifact) return path.join(artifactDir, artifact.name);
  const relativePath = pathname === "/" ? "converter.html" : pathname.replace(/^\//, "");
  return path.join(rendererRoot, relativePath);
}

function isAvailableOfficeServerFile(
  localPath: string,
  root: string,
  fileExists: (filePath: string) => boolean,
): boolean {
  return localPath.startsWith(`${root}${path.sep}`) && fileExists(localPath);
}

export function resolveOfficeServerFile(
  artifactDir: string,
  rendererRoot: string,
  pathname: string,
  fileExists: (filePath: string) => boolean = fs.existsSync,
): OfficeServerFile | null {
  const artifact = officeArtifactForPath(pathname);
  const root = artifact ? artifactDir : rendererRoot;
  const localPath = officeServerPath(artifact, artifactDir, rendererRoot, pathname);
  if (!isAvailableOfficeServerFile(localPath, root, fileExists)) return null;
  return { artifact, localPath };
}

export function setOfficeResponseHeaders(response: OfficeHeaderResponse, file: OfficeServerFile): void {
  if (file.artifact) {
    response.setHeader("Content-Type", file.artifact.contentType);
    if (file.artifact.brotli) response.setHeader("Content-Encoding", "br");
    return;
  }
  const contentType = file.localPath.endsWith(".html")
    ? "text/html; charset=utf-8"
    : "application/javascript; charset=utf-8";
  response.setHeader("Content-Type", contentType);
}

export class OfficeConverter {
  private server: http.Server | null = null;
  private window: import("electron").BrowserWindow | null = null;
  private electron: ElectronModule | null = null;
  private baseUrl = "";
  private chain: Promise<unknown> = Promise.resolve();
  private completedInWindow = 0;

  constructor(
    private readonly artifactDir: string,
    private readonly files: OfficeConverterFiles = defaultOfficeConverterFiles,
    private readonly runtime: OfficeConverterRuntime = defaultOfficeConverterRuntime,
  ) {}

  convert(name: string, bytes: Uint8Array): Promise<Buffer> {
    const task = this.chain.then(() => this.convertOne(name, bytes));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async boot(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) return;
    this.electron = await this.runtime.loadElectron();
    const rendererRoot = path.join(this.electron.app.getAppPath(), "dist_renderer", "office");
    this.server = this.runtime.createServer((request, response) => {
      this.serveOfficeRequest(request, response, rendererRoot);
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

  private serveOfficeRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    rendererRoot: string,
  ): void {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    this.setIsolationHeaders(response);
    const file = resolveOfficeServerFile(this.artifactDir, rendererRoot, requestUrl.pathname, this.files.fileExists);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    setOfficeResponseHeaders(response, file);
    this.files.openReadStream(file.localPath).pipe(response);
  }

  private setIsolationHeaders(response: http.ServerResponse): void {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
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
      // The Promise executor above runs synchronously, so the timer exists
      // before control can reach this try/finally block.
      clearTimeout(timeoutId);
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
