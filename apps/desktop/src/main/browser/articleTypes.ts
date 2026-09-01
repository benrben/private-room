import type { Readability } from "@mozilla/readability";
import type { PageMeta } from "../../shared/apiTypes.js";

export interface DomNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
}

export interface DomElement extends DomNode {
  tagName: string;
  children: ArrayLike<DomElement>;
  attributes: ArrayLike<{ name: string }>;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

export interface DomDocument extends DomNode {
  documentElement: DomElement | null;
  body: (DomElement & { innerHTML: string }) | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

export type LibDomDocument = ConstructorParameters<typeof Readability>[0];

export interface ArticleBody {
  html: string;
  markdown: string;
  text: string;
}

export interface PageCapture {
  meta: PageMeta;
  article: ArticleBody | null;
}

/** Readability's internal metadata surface, pinned by the article tests. */
export interface InternalMetaReader {
  _getJSONLD(doc: LibDomDocument): Record<string, unknown>;
  _getArticleMetadata(jsonld: Record<string, unknown>): {
    title?: string;
    byline?: string;
    siteName?: string;
    publishedTime?: string;
    excerpt?: string;
  };
}
