import type { LatLngTuple, TileLayer } from "leaflet";

/**
 * source: https://iiif.io/api/image/2.0/#format
 */
type TileFormat = "jpg" | "tif" | "png" | "gif" | "jp2" | "pdf" | "webp";

/**
 * source: https://iiif.io/api/image/2.0/#quality
 */
type Quality = "default" | "gray" | "color" | "bitonal";

export type IiifOptions = {
  tileFormat?: TileFormat;
  tileSize?: number;
  /**
   * If set to true, fit the bounds of the image to the viewport (center + zoom) on map load
   * Otherwise it will center the image on the viewport (center only)
   */
  fitBounds?: boolean;
  /**
   * If set to true, set the max bounds of the image to the viewport (center + zoom)
   */
  setMaxBounds?: boolean;
  quality?: Quality;
  maxZoom?: number;
  /**
   * Number of extra tiles to load beyond the map view on each edge.
   */
  edgeBufferTiles?: number;
};

export type IiifInitializeParams = {
  publicUri?: string;
  manifest?: IiifManifest;
  presignedImageUrls?: globalThis.Map<string, string>;
};

// Library-specific
export type IiifProfileEntry = {
  formats?: string[];
  qualities?: string[];
  [key: string]: unknown;
};

export type IiifInfo = {
  profile?: IiifProfileEntry | IiifProfileEntry[];
  formats?: string[];
  extraFormats?: string[];
};

export type IiifTileFormatThis = TileLayer & {
  _explicitTileFormat?: boolean;
  options: { tileFormat: string };
};

export type Tile = {
  scaleFactors: number[];
  width: number;
};

export type IiifManifest = {
  "@context": string;
  "@id": string;
  profile: IiifInfo["profile"][];
  protocol: string;
  tiles: Tile[];
  width: number;
  height: number;
};

// Required types to override leaflet's types package
declare module "leaflet" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace TileLayer {
    class Iiif {
      constructor(params: IiifInitializeParams, options?: IiifOptions);
      addTo(map: Map): this;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace tileLayer {
    function iiif(
      params: IiifInitializeParams,
      options?: IiifOptions,
    ): TileLayer.Iiif;
  }
  interface Map {
    _leaflet_id: string;
    _layersMinZoom: number;
    _layersMaxZoom: number;
    _layers: {
      [key: string]: Layer;
    };
  }
  interface TileLayer {
    tile: HTMLImageElement;
  }
  interface Layer {
    _latlng: LatLng;
  }
  interface Marker {
    _leaflet_id: string;
    _latlng: LatLng;
  }
  interface Popup {
    _leaflet_id: string;
    _latlng: LatLng;
  }
  interface GridLayer {
    _getTiledPixelBounds(
      center: Coords,
      zoom: number,
      tileZoom: number,
    ): Bounds;
  }
}
