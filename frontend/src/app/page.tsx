import { Workspace } from "@/features/shell/Workspace";

/**
 * The whole app. Exported as a static shell that the client fills in: the
 * surface is a canvas over data fetched from the API at run time, so the
 * prerendered HTML is the frame and nothing more.
 */
export default function Page() {
  return <Workspace />;
}
