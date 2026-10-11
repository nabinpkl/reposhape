import type { Metadata } from "next";

import { FolderView } from "@/features/folder-view/FolderView";

export const metadata: Metadata = {
  title: "reposhape · folder",
  description: "Any folder on this machine as nested circles, read in the browser.",
};

/** A folder picked in the browser, drawn as the folder map. No API calls. */
export default function Page() {
  return <FolderView />;
}
