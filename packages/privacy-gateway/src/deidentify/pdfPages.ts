import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { encodeRasterAs, type Raster } from "../redaction/raster.ts";

/**
 * A PDF as pictures of its pages, and pictures as a PDF. A PDF's own text is not what a person
 * sees: Arabic is stored in drawing order and a filled form keeps its answers in annotations. So
 * a page is drawn here and read as a picture, and the copy is made of the redacted pictures only.
 */

/** The file could not be opened or drawn as a PDF. */
export class UnreadablePdfError extends Error {
  override readonly name = "UnreadablePdfError";
}

export interface PdfRenderOptions {
  /** Pixels for each point of the page. 200 dots an inch unless said: print stays crisp. */
  readonly scale?: number | undefined;
  /** A page that would be larger than this in pixels is drawn smaller. */
  readonly maxPagePixels?: number | undefined;
  /** More pages than this and the file is refused before any is drawn. */
  readonly maxPages?: number | undefined;
}

const DEFAULT_SCALE = 200 / 72;
const DEFAULT_MAX_PAGE_PIXELS = 16_000_000;
const DEFAULT_MAX_PAGES = 500;

export interface RenderedPage {
  /** Counted from 0. */
  readonly index: number;
  /** The page's size in points, turned as it is shown. */
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly raster: Raster;
}

export interface OpenedPdf {
  readonly pageCount: number;
  /** One page's size in points, turned as it is shown, without drawing it. */
  readonly pageSize: (
    index: number,
  ) => Promise<{ readonly width: number; readonly height: number }>;
  /** Draws one page: its contents, its form fields and its annotations, as a viewer shows it. */
  readonly renderPage: (index: number) => Promise<RenderedPage>;
  readonly close: () => Promise<void>;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let library: Promise<{ readonly pdfjs: PdfJs; readonly root: string }> | undefined;
/** Loaded on first use: a machine where it cannot load refuses PDFs and nothing else. */
const loadLibrary = (): Promise<{ readonly pdfjs: PdfJs; readonly root: string }> => {
  library ??= (async () => {
    try {
      const require = NodeModule.createRequire(import.meta.url);
      // The canvas the pages are drawn on. Asked for by name so its absence is an error here,
      // not a blank page later.
      require.resolve("@napi-rs/canvas");
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      return { pdfjs, root: NodePath.dirname(require.resolve("pdfjs-dist/package.json")) };
    } catch (cause) {
      library = undefined;
      throw new UnreadablePdfError("The PDF library could not be loaded.", { cause });
    }
  })();
  return library;
};

interface PageCanvas {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly context: {
    readonly getImageData: (
      x: number,
      y: number,
      width: number,
      height: number,
    ) => { readonly data: Uint8ClampedArray };
  };
}

interface CanvasFactory {
  readonly create: (width: number, height: number) => PageCanvas;
  readonly destroy: (canvas: PageCanvas) => void;
}

/** Opens a PDF for drawing. Nothing is fetched: fonts and character maps come from the package. */
export const openPdf = async (
  bytes: Buffer,
  options: PdfRenderOptions = {},
): Promise<OpenedPdf> => {
  const { pdfjs, root } = await loadLibrary();
  const scale = options.scale ?? DEFAULT_SCALE;
  const maxPagePixels = options.maxPagePixels ?? DEFAULT_MAX_PAGE_PIXELS;
  let document: Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
  let task: ReturnType<PdfJs["getDocument"]> | undefined;
  const close = async () => {
    await task?.destroy();
  };
  try {
    task = pdfjs.getDocument({
      // A copy: the library takes the buffer it is given for its own.
      data: new Uint8Array(bytes),
      standardFontDataUrl: `${NodePath.join(root, "standard_fonts")}${NodePath.sep}`,
      cMapUrl: `${NodePath.join(root, "cmaps")}${NodePath.sep}`,
      cMapPacked: true,
      wasmUrl: `${NodePath.join(root, "wasm")}${NodePath.sep}`,
      useSystemFonts: false,
      enableXfa: false,
      verbosity: 0,
    });
    document = await task.promise;
  } catch (cause) {
    await close().catch(() => undefined);
    throw new UnreadablePdfError("The PDF is damaged, protected or could not be opened.", {
      cause,
    });
  }
  if (document.numPages > (options.maxPages ?? DEFAULT_MAX_PAGES)) {
    const pages = document.numPages;
    await close();
    throw new UnreadablePdfError(`The PDF has ${pages} pages, more than can be de-identified.`);
  }
  const factory = (document as unknown as { readonly canvasFactory: CanvasFactory }).canvasFactory;
  return {
    pageCount: document.numPages,
    pageSize: async (index) => {
      const page = await document.getPage(index + 1);
      try {
        const size = page.getViewport({ scale: 1 });
        return { width: size.width, height: size.height };
      } finally {
        page.cleanup();
      }
    },
    renderPage: async (index) => {
      const page = await document.getPage(index + 1);
      try {
        const size = page.getViewport({ scale: 1 });
        const fitted = Math.min(scale, Math.sqrt(maxPagePixels / (size.width * size.height)));
        const viewport = page.getViewport({ scale: fitted });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const target = factory.create(width, height);
        try {
          await page.render({
            canvas: target.canvas,
            canvasContext: target.context,
            viewport,
            background: "#ffffff",
          } as unknown as Parameters<typeof page.render>[0]).promise;
          const { data } = target.context.getImageData(0, 0, width, height);
          const raster = Buffer.alloc(width * height * 3);
          for (let pixel = 0; pixel < width * height; pixel += 1) {
            raster[pixel * 3] = data[pixel * 4] as number;
            raster[pixel * 3 + 1] = data[pixel * 4 + 1] as number;
            raster[pixel * 3 + 2] = data[pixel * 4 + 2] as number;
          }
          return {
            index,
            widthPoints: size.width,
            heightPoints: size.height,
            raster: { width, height, data: raster },
          };
        } finally {
          factory.destroy(target);
        }
      } catch (cause) {
        if (cause instanceof UnreadablePdfError) throw cause;
        throw new UnreadablePdfError(`Page ${index + 1} of the PDF could not be drawn.`, { cause });
      } finally {
        page.cleanup();
      }
    },
    close,
  };
};

/** A photograph deflates to more than this share of its size: it is stored as JPEG instead. */
const PHOTO_SHARE = 0.25;

const number = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Writes a PDF whose every page is one picture, at the size the page had. Written from the
 * pictures alone: there is no text, annotation, link, attachment or information dictionary to
 * carry anything over from the file the pictures came from.
 */
export class PagePdfBuilder {
  readonly #pages: Array<{
    readonly width: number;
    readonly height: number;
    readonly pixelWidth: number;
    readonly pixelHeight: number;
    readonly filter: "FlateDecode" | "DCTDecode";
    readonly stream: Buffer;
  }> = [];

  async addPage(raster: Raster, widthPoints: number, heightPoints: number): Promise<void> {
    const deflated = NodeZlib.deflateSync(raster.data, { level: 6 });
    const photo = deflated.length > raster.data.length * PHOTO_SHARE;
    this.#pages.push({
      width: widthPoints,
      height: heightPoints,
      pixelWidth: raster.width,
      pixelHeight: raster.height,
      filter: photo ? "DCTDecode" : "FlateDecode",
      stream: photo ? await encodeRasterAs(raster, "jpeg") : deflated,
    });
  }

  finish(): Buffer {
    const chunks: Array<Buffer> = [];
    const offsets: Array<number> = [];
    let length = 0;
    const write = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
      chunks.push(bytes);
      length += bytes.length;
    };
    const object = (id: number, dictionary: string, stream?: Buffer) => {
      offsets[id] = length;
      write(`${id} 0 obj\n${dictionary}\n`);
      if (stream !== undefined) {
        write("stream\n");
        write(stream);
        write("\nendstream\n");
      }
      write("endobj\n");
    };
    // 1 is the catalogue, 2 the page tree; each page then takes three: page, drawing, picture.
    const pageId = (index: number) => 3 + index * 3;
    write("%PDF-1.4\n%âãÏÓ\n");
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(
      2,
      `<< /Type /Pages /Count ${this.#pages.length} /Kids [${this.#pages
        .map((_, index) => `${pageId(index)} 0 R`)
        .join(" ")}] >>`,
    );
    this.#pages.forEach((page, index) => {
      const id = pageId(index);
      const drawing = Buffer.from(
        `q ${number(page.width)} 0 0 ${number(page.height)} 0 0 cm /Im0 Do Q`,
        "latin1",
      );
      object(
        id,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(page.width)} ${number(page.height)}] ` +
          `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
      );
      object(id + 1, `<< /Length ${drawing.length} >>`, drawing);
      object(
        id + 2,
        `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${page.filter} ` +
          `/Length ${page.stream.length} >>`,
        page.stream,
      );
    });
    const count = 3 + this.#pages.length * 3;
    const start = length;
    write(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id += 1) {
      write(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`);
    }
    write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}
