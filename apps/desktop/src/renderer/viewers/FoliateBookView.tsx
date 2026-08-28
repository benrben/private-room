import { useEffect, useMemo, useState } from "react";
import { unzipSync, unzlib } from "fflate";
import { declareGeneratedMarkupUtf8 } from "./bookEncoding";

interface FoliateSection {
  load(): Promise<string> | string;
  unload?(): void;
}

interface FoliateBook {
  metadata?: { title?: string };
  sections: FoliateSection[];
  destroy?(): void;
}

function inflate(data: ArrayBuffer): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    unzlib(new Uint8Array(data), (error, output) => {
      if (error) reject(error);
      else if (!output) reject(new Error("The compressed book resource was empty."));
      else resolve(output);
    });
  });
}

async function openBook(name: string, bytes: Uint8Array): Promise<FoliateBook> {
  const lower = name.toLocaleLowerCase();
  const file = new File([bytes], name);
  if (/\.(mobi|azw|azw3)$/i.test(lower)) {
    const { MOBI } = await import("foliate-js/mobi.js");
    return await new MOBI({ unzlib: inflate }).open(file) as FoliateBook;
  }
  if (lower.endsWith(".fb2")) {
    const { makeFB2 } = await import("foliate-js/fb2.js");
    return await makeFB2(file) as FoliateBook;
  }
  if (lower.endsWith(".cbz")) {
    const { makeComicBook } = await import("foliate-js/comic-book.js");
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    return await makeComicBook({
      entries: names.map((filename) => ({ filename })),
      loadBlob: async (filename: string) => new Blob([files[filename]!]),
      getSize: (filename: string) => files[filename]?.byteLength ?? 0,
      getComment: async () => null,
    }, file) as FoliateBook;
  }
  throw new Error("This book format is not supported.");
}

export default function FoliateBookView({ name, bytes }: { name: string; bytes: Uint8Array }) {
  const [book, setBook] = useState<FoliateBook | null>(null);
  const [error, setError] = useState("");
  const [at, setAt] = useState(0);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let alive = true;
    let owned: FoliateBook | null = null;
    setBook(null);
    setError("");
    setAt(0);
    void openBook(name, bytes).then((opened) => {
      owned = opened;
      if (!alive) return opened.destroy?.();
      if (!opened.sections.length) throw new Error("No readable pages were found.");
      setBook(opened);
    }).catch((reason) => {
      if (alive) setError(`This book could not be read: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => {
      alive = false;
      owned?.destroy?.();
    };
  }, [name, bytes]);

  useEffect(() => {
    const section = book?.sections[at];
    if (!section) return;
    const generatedMarkup = /\.(?:mobi|azw|azw3)$/i.test(name);
    let alive = true;
    let ownedUrl = "";
    setUrl("");
    void Promise.resolve(section.load()).then(async (next) => {
      // Comic-book sections are image blob URLs, not generated markup. FB2's
      // own loader already emits UTF-8. Hand both through untouched and keep
      // this repair strictly on the MOBI family that can retain a stale
      // source-charset declaration.
      if (!generatedMarkup) {
        if (alive) setUrl(next);
        else section.unload?.();
        return;
      }
      // `section.load()` returns a foliate-owned blob URL. Read the generated
      // markup as UTF-8 (Response.text's defined decoding), correct any stale
      // source charset declaration, and own the small replacement URL here.
      // Resource URLs inside the page are already absolute blob URLs, so this
      // does not disturb pictures or styles.
      const response = await fetch(next);
      if (!response.ok) throw new Error(`The generated page returned ${response.status}.`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim()
        || "text/html";
      const markup = await response.text();
      ownedUrl = URL.createObjectURL(new Blob(
        [declareGeneratedMarkupUtf8(markup)],
        { type: `${contentType};charset=utf-8` },
      ));
      if (alive) setUrl(ownedUrl);
      else URL.revokeObjectURL(ownedUrl);
    }).catch((reason) => {
      if (alive) setError(`This page could not be shown: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => {
      alive = false;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
      section.unload?.();
    };
  }, [book, at, name]);

  const title = useMemo(() => book?.metadata?.title || name, [book, name]);
  if (error) return <div className="empty-hint">{error}</div>;
  if (!book) return <div className="empty-hint">Opening book…</div>;
  return (
    <div className="book-view" tabIndex={-1}>
      <div className="book-bar rdr-bar">
        <button className="nb-btn" disabled={at === 0} onClick={() => setAt((value) => Math.max(0, value - 1))}>
          Previous
        </button>
        <span className="book-where" title={title}>{title} · {at + 1} of {book.sections.length}</span>
        <button
          className="nb-btn"
          disabled={at >= book.sections.length - 1}
          onClick={() => setAt((value) => Math.min(book.sections.length - 1, value + 1))}
        >
          Next
        </button>
      </div>
      <div className="book-page">
        {url ? <iframe title={`${title}, page ${at + 1}`} src={url} sandbox="" /> : <div className="empty-hint">Drawing page…</div>}
      </div>
    </div>
  );
}
