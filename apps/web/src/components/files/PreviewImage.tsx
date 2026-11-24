import { lazy, Suspense } from "react";

import { TextlessFileValueMarkSurface } from "../privacy/FileValueMarkSurface";
import { FileSurfaceLoading } from "./fileSurfaceChrome";

const PreviewImageContent = lazy(() => import("./PreviewImageContent"));

export function PreviewImage(props: {
  readonly src: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly onError?: () => void;
}) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <TextlessFileValueMarkSurface />
      <PreviewImageContent {...props} />
    </Suspense>
  );
}
