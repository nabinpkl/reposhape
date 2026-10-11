/**
 * A folder on this machine, read in the browser. Nothing is uploaded: the
 * files stay `File` handles in this tab, and the map is built from their
 * paths and sizes.
 *
 * Two ways in, one result. A folder dropped on the page arrives as directory
 * entries, which are walked here and can skip a directory without opening it.
 * A folder picked with the button arrives as a flat list the browser already
 * walked, `webkitdirectory` having no way to be told what to leave out, so the
 * same rule is applied to the paths afterwards.
 */

export interface PickedFolder {
  /** The folder's own name. Paths below are relative to it. */
  name: string;
  files: Map<string, File>;
  /**
   * The names of the directories left out (see SKIPPED_DIRECTORIES), said on
   * the page rather than silently dropped.
   */
  skipped: string[];
  /** True when the folder held more files than one view draws. */
  truncated: boolean;
}

/**
 * Directories that are tooling output rather than the folder's own content.
 * Each one can outnumber everything else put together (one `node_modules` is
 * tens of thousands of files), so drawing them would draw only them.
 */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", ".next"]);

/** Files that are an operating system's, not the folder's. */
const SKIPPED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/**
 * How many files one view draws. The map was measured at 2,581 files with a
 * frame at 1ms, and hermes-agent's 10,045 still packs; past this a dot is
 * smaller than a pixel at fit, so more files add time and nothing visible.
 */
export const MAX_FILES = 20_000;

/** The skipped directory a path is under, if any. */
function skippedUnder(path: string): string | undefined {
  return path.split("/").slice(0, -1).find((segment) => SKIPPED_DIRECTORIES.has(segment));
}

/** The flat list `<input webkitdirectory>` hands over. */
export function fromFileList(list: FileList): PickedFolder {
  const files = new Map<string, File>();
  let name = "";
  const skipped = new Set<string>();
  let truncated = false;
  for (const file of Array.from(list)) {
    // `webkitRelativePath` starts with the picked folder's own name.
    const [root = "", ...rest] = file.webkitRelativePath.split("/");
    name ||= root;
    const path = rest.join("/");
    if (!path || SKIPPED_FILES.has(rest.at(-1) ?? "")) continue;
    const under = skippedUnder(path);
    if (under) {
      skipped.add(under);
      continue;
    }
    if (files.size >= MAX_FILES) {
      truncated = true;
      break;
    }
    files.set(path, file);
  }
  return { name, files, skipped: [...skipped].sort(), truncated };
}

/**
 * What a drop hands over: one directory entry, walked here. A dropped file
 * rather than a folder is refused by the caller, because a map of one file is
 * a dot.
 */
export async function fromDirectoryEntry(root: FileSystemDirectoryEntry): Promise<PickedFolder> {
  const files = new Map<string, File>();
  const skipped = new Set<string>();
  let truncated = false;

  const walk = async (directory: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    for (const entry of await readAll(directory)) {
      if (truncated) return;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          skipped.add(entry.name);
          continue;
        }
        await walk(entry as FileSystemDirectoryEntry, path);
      } else if (entry.isFile) {
        if (SKIPPED_FILES.has(entry.name)) continue;
        if (files.size >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.set(path, await fileOf(entry as FileSystemFileEntry));
      }
    }
  };
  await walk(root, "");
  return { name: root.name, files, skipped: [...skipped].sort(), truncated };
}

/**
 * Every child of a directory. `readEntries` answers in batches (Chrome's are
 * a hundred long) and only an empty batch means the end, so one call reads a
 * large directory short.
 */
async function readAll(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
