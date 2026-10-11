/**
 * reposhape-viewer: any tree of files as nested circles, with a file pane.
 *
 * `FolderViewer` is the whole thing in one component. `FolderMap` and
 * `FilePane` are its two halves, for a layout of your own. All of them draw
 * `FolderData`: paths, and optionally a size, a group and links per file.
 */
export { FolderViewer, type FolderViewerProps } from "./FolderViewer";
export { FolderMap, type FolderMapProps, type MapLabels } from "./FolderMap";
export { FilePane, formatBytes, type FilePaneProps } from "./FilePane";
export { CodeBlock } from "./CodeBlock";
export { readBrowserFile, MAX_TEXT_BYTES, type FileContent } from "./fileContent";
export {
  toShape,
  kindOf,
  type FolderData,
  type FolderFile,
  type FolderGroup,
  type FolderLink,
  type Shape,
  type ShapeGroup,
  type ShapeItem,
} from "./shape";
export type { Sizing } from "./mapLayout";
export type { EdgeSummary as LinkSummary, Packages } from "./mapEdges";
export { OTHER_COLOR, PALETTE } from "./palette";
// The canvas colours, for an app that draws other views of the same files
// and wants a file to be the same colour in all of them.
export { SCHEMES, discColor, fullValue, mixHex, type ColorScheme } from "./colors";
