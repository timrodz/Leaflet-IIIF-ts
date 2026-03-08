import {
  IiifInitializeParams,
  IiifManifest,
  IiifTileFormatThis,
} from "./types";

export function ceilLog2(x: number) {
  return Math.ceil(Math.log(x) / Math.LN2);
}

export function getManifestIdAsJsonExtension(manifest: IiifManifest): string {
  const id = manifest["@id"];
  if (id.endsWith("/info.json")) {
    return id;
  }
  const str = id + "/info.json";
  return str;
}

export function areParamsValid(params: IiifInitializeParams): boolean {
  const hasManifest = !!params.manifest;
  const hasUrl = !!params.publicUri;
  if (hasManifest && hasUrl) {
    console.error(
      "both manifest and publicUri are provided - choose one method",
    );
    return false;
  }
  return hasManifest || hasUrl;
}
