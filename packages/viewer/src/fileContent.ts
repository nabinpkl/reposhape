/**
 * What a file pane shows. The pane never fetches: whoever renders it decides
 * where content comes from (a server, a picked file, memory) and hands back
 * one of these.
 */
export type FileContent =
  | {
      kind: "text";
      text: string;
      /** Bytes on disk, for the meta line. */
      size?: number;
      /** True when `text` is only the start of the file. */
      truncated?: boolean;
    }
  | {
      kind: "image";
      /** Anything an <img> takes: a URL, a data: or blob: URL. */
      src: string;
      size?: number;
      /** Called when the pane lets go of it, e.g. to revoke a blob: URL. */
      dispose?: () => void;
    }
  | { kind: "binary"; size?: number };

/**
 * Text past this is cut for display. The pane is for reading a file, and half
 * a megabyte is already more than anyone scrolls.
 */
export const MAX_TEXT_BYTES = 512 * 1024;

/**
 * How far in to look for a NUL byte, git's own test for "binary". A text file
 * has none, and almost every binary format has one in its first block.
 */
const SNIFF_BYTES = 8000;

/**
 * A browser `File` (from a file input, a drop, the File System Access API) as
 * pane content: an image by its type, text when its first block has no NUL
 * byte, binary otherwise.
 */
export async function readBrowserFile(file: File): Promise<FileContent> {
  if (file.type.startsWith("image/")) {
    // An <img> never runs what it shows, an SVG's scripts included, so an
    // object URL is safe to hand it.
    const src = URL.createObjectURL(file);
    return { kind: "image", src, size: file.size, dispose: () => URL.revokeObjectURL(src) };
  }
  const bytes = new Uint8Array(await file.slice(0, MAX_TEXT_BYTES).arrayBuffer());
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary", size: file.size };
  return {
    kind: "text",
    text: new TextDecoder().decode(bytes),
    size: file.size,
    truncated: file.size > MAX_TEXT_BYTES,
  };
}
