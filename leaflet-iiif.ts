/**
 * Leaflet-IIIF 3.1.0
 * IIIF Viewer for Leaflet
 * by Jack Reed, @mejackreed
 *
 * Adapted for TypeScript by Juan Rodriguez, @timrodz with these added extras:
 * - Support for parsed manifests (vs. downloading them for public URLs)
 * - Support for multiple image formats and sizes
 * - Support for presigned image URLs
 * - Keeps the original implementation relatively intact
 * - Prefers a parsed IIIF manifest over public URL, as it reduces the need for
 *   downloading extra resources over the network if they're known beforehand
 */

import {
  type Coords,
  extend,
  latLngBounds,
  Map as LeafletMap,
  Point,
  point,
  setOptions,
  type TileEvent,
  TileLayer,
  tileLayer,
  Util,
} from "leaflet";

import {
  DEFAULT_TILE_SIZE_PIXELS,
  DEFAULT_ZOOM,
  IIIF_TILE_SUFFIX_FORMAT,
  MAX_BOUNDS_TOLERANCE,
  MAX_BOUNDS_VISCOSITY,
  ZOOM_ITERATION_CHECK_MAX_ATTEMPTS,
} from "./constants";
import {
  IiifInfo,
  IiifInitializeParams,
  IiifManifest,
  IiifOptions,
  IiifProfileEntry,
  IiifTileFormatThis,
} from "./types";
import {
  areParamsValid,
  ceilLog2,
  getManifestIdAsJsonExtension,
} from "./utils";

const defaultOptions = {
  continuousWorld: true,
  tileSize: DEFAULT_TILE_SIZE_PIXELS,
  updateWhenIdle: true,
  tileFormat: "jpg",
  fitBounds: true,
  setMaxBounds: false,
};

TileLayer.Iiif = TileLayer.extend({
  options: defaultOptions,

  initialize: function (params: IiifInitializeParams, options: IiifOptions) {
    if (!areParamsValid(params)) {
      return;
    }

    options = options ?? {};

    if (options.maxZoom) {
      this._customMaxZoom = true;
    }

    // Check for explicit tileSize set
    if (options.tileSize) {
      this._explicitTileSize = true;
    }

    // Check for an explicit quality
    if (options.quality) {
      this._explicitQuality = true;
    }

    // Check for an explicit tileFormat
    if (options.tileFormat) {
      this._explicitTileFormat = true;
    }

    options = setOptions(this, options);
    this._infoPromise = null;

    this._presignedImageUrls = params.presignedImageUrls;

    if (params.manifest) {
      // Dynamically compute the info.json URL
      // The base directory URL is represented in the @id field of the manifest
      // Example: http://localhost:4566/dev-bucket/us/org/1/zoomable-locations/2/map.iiif
      this._infoUrl = getManifestIdAsJsonExtension(params.manifest);
      this._baseUrl = this._templateUrl();
      this._assignInfo(params.manifest);
      this._hasManifest = true;
      return;
    }

    if (params.publicUri) {
      this._infoUrl = params.publicUri;
      this._baseUrl = this._templateUrl();
      this._getInfo();
    }
  },
  getTileUrl: function (coords: Coords) {
    const _this = this,
      x = coords.x,
      y = coords.y,
      zoom = _this._getZoomForUrl(),
      scale = Math.pow(2, _this.maxNativeZoom - zoom),
      tileSize = _this.options.tileSize,
      tileBaseSize = tileSize * scale,
      minx = x * tileBaseSize,
      miny = y * tileBaseSize,
      maxx = Math.min(minx + tileBaseSize, _this.x),
      maxy = Math.min(miny + tileBaseSize, _this.y);

    const xDiff = maxx - minx;
    const yDiff = maxy - miny;

    const size = Math.ceil(xDiff / scale) + ",";

    const isFullImage =
      minx === 0 && miny === 0 && xDiff === _this.x && yDiff === _this.y;
    const templateParams = extend(
      {
        region: isFullImage ? "full" : [minx, miny, xDiff, yDiff].join(","),
        size: size,
        rotation: 0,
        quality: _this.quality,
        format: _this.options.tileFormat,
      },
      this.options,
    );

    const url = Util.template(this._baseUrl, templateParams);

    if (!this._presignedImageUrls) {
      return url;
    }

    /**
     * When presigned tile URLs are provided, we do NOT rely on the base URL.
     * Instead, we key into the map using only the IIIF template suffix:
     *   {region}/{size}/{rotation}/{quality}.{format}
     *
     * This works for both S3 and CDN URLs (and ignores query params).
     */
    const suffixKey = this._getSuffixKey(templateParams);
    const presigned = this._presignedImageUrls.get(suffixKey);
    return presigned ?? url;
  },
  _getSuffixKey: function (templateParams: {
    region: string;
    size: string;
    rotation: string;
    quality: string;
    format: string;
  }) {
    return `${templateParams.region}/${templateParams.size}/${templateParams.rotation}/${templateParams.quality}.${templateParams.format}`;
  },
  onAdd: function (map: LeafletMap) {
    const _this = this;

    function onAddComplete() {
      // Store unmutated imageSizes
      _this._imageSizesOriginal = _this._imageSizes.slice(0);

      // Set maxZoom for map
      map._layersMaxZoom = _this.maxZoom;

      // Call add TileLayer
      TileLayer.prototype.onAdd.call(_this, map);

      // Set minZoom and minNativeZoom based on how the imageSizes match up
      let smallestImage = _this._imageSizes[0];
      const mapSize = _this._map.getSize();
      let newMinZoom = 0;

      // Attempt to find a better fit
      for (let i = 1; i <= ZOOM_ITERATION_CHECK_MAX_ATTEMPTS; i++) {
        if (smallestImage.x > mapSize.x || smallestImage.y > mapSize.y) {
          smallestImage = smallestImage.divideBy(2);
          _this._imageSizes.unshift(smallestImage);
          newMinZoom = -i;
        } else {
          break;
        }
      }
      _this.options.minZoom = newMinZoom;
      _this.options.minNativeZoom = newMinZoom;
      _this._prev_map_layersMinZoom = _this._map._layersMinZoom;
      _this._map._layersMinZoom = newMinZoom;

      // If set to true, fit the bounds of the image to the viewport (center + zoom)
      // Otherwise it will center the image on the viewport (center only)
      if (_this.options.fitBounds) {
        _this._fitBounds();
      } else {
        const { center } = _this._getImageBounds();
        _this._map.setView(center, null, true);
      }

      if (_this.options.setMaxBounds) {
        _this._setMaxBounds();
      }

      // Reset tile sizes to handle non 256x256 IIIF tiles
      _this.on("tileload", function (e: TileEvent) {
        const height = e.tile.naturalHeight,
          width = e.tile.naturalWidth;

        // No need to resize if tile is DEFAULT_TILE_SIZE_PIXELS x DEFAULT_TILE_SIZE_PIXELS
        if (
          height === DEFAULT_TILE_SIZE_PIXELS &&
          width === DEFAULT_TILE_SIZE_PIXELS
        ) {
          return;
        }

        e.tile.style.width = width + "px";
        e.tile.style.height = height + "px";
      });
    }

    if (this._hasManifest) {
      onAddComplete();
    } else {
      // Wait for info.json fetch and parse to complete
      Promise.all([_this._infoPromise])
        .then(onAddComplete)
        .catch(function (err) {
          console.error(err);
        });
    }
  },
  onRemove: function (map: LeafletMap) {
    const _this = this;

    map._layersMinZoom = _this._prev_map_layersMinZoom;
    _this._imageSizes = _this._imageSizesOriginal;

    // Remove maxBounds set for this image
    if (_this.options.setMaxBounds) {
      map.setMaxBounds(undefined);
    }

    // Call remove TileLayer
    TileLayer.prototype.onRemove.call(_this, map);
  },
  _getImageBounds: function () {
    const _this = this;
    const mapSize = _this._map.getSize();

    const initialZoom = _this._getInitialZoom(mapSize);
    const offset = _this._imageSizes.length - 1 - _this.options.maxNativeZoom;
    const imageSize = _this._imageSizes[initialZoom + offset];
    const southWest = _this._map.options.crs.pointToLatLng(
      point(0, imageSize.y),
      initialZoom,
    );
    const northEast = _this._map.options.crs.pointToLatLng(
      point(imageSize.x, 0),
      initialZoom,
    );
    const bounds = latLngBounds(southWest, northEast);

    const centerLatitude = (southWest.lat + northEast.lat) / 2;
    const centerLongitude = (southWest.lng + northEast.lng) / 2;
    const center = [centerLatitude, centerLongitude];
    const minZoomToFitViewport = _this._map.getBoundsZoom(bounds, true);

    return { bounds, center, minZoomToFitViewport };
  },
  _fitBounds: function () {
    const _this = this;
    const { center, minZoomToFitViewport } = _this._getImageBounds();
    _this._map.setView(center, minZoomToFitViewport, true);
  },
  _setMaxBounds: function () {
    const _this = this;
    const { bounds, minZoomToFitViewport } = _this._getImageBounds();
    _this._map.setMaxBounds(bounds);
    _this._map.setMinZoom(minZoomToFitViewport);
    _this._map.options.maxBoundsViscosity = MAX_BOUNDS_VISCOSITY;
  },
  _assignInfo: function (data: IiifManifest) {
    const _this = this;

    _this.y = data.height;
    _this.x = data.width;

    const tierSizes = [],
      imageSizes = [];
    let scale, width_, height_, tilesX_, tilesY_;

    // Set quality based off of IIIF version
    if (data.profile instanceof Array) {
      _this.profile = data.profile[0];
    } else {
      _this.profile = data.profile;
    }

    _this._setQuality();

    // Infer tile format if not explicitly provided
    _this._setTileFormat(data);

    // Unless an explicit tileSize is set, use a preferred tileSize
    if (!_this._explicitTileSize) {
      // Set the default first
      _this.options.tileSize = DEFAULT_TILE_SIZE_PIXELS;
      _this.options.tileSize = data.tiles[0]?.width ?? DEFAULT_TILE_SIZE_PIXELS;
    }

    // Calculates maximum native zoom for the layer
    _this.maxNativeZoom = Math.max(
      ceilLog2(_this.x / _this.options.tileSize),
      ceilLog2(_this.y / _this.options.tileSize),
      0,
    );
    _this.options.maxNativeZoom = _this.maxNativeZoom;

    // Enable zooming further than native if maxZoom option supplied
    if (_this._customMaxZoom && _this.options.maxZoom > _this.maxNativeZoom) {
      _this.maxZoom = _this.options.maxZoom;
    } else {
      _this.maxZoom = _this.maxNativeZoom;
    }

    for (let i = 0; i <= _this.maxZoom; i++) {
      scale = Math.pow(2, _this.maxNativeZoom - i);
      width_ = Math.ceil(_this.x / scale);
      height_ = Math.ceil(_this.y / scale);
      tilesX_ = Math.ceil(width_ / _this.options.tileSize);
      tilesY_ = Math.ceil(height_ / _this.options.tileSize);
      tierSizes.push([tilesX_, tilesY_]);
      imageSizes.push(point(width_, height_));
    }

    _this._tierSizes = tierSizes.length > 0 ? tierSizes : [[0, 0]];
    _this._imageSizes = imageSizes.length > 0 ? imageSizes : [point(0, 0)];
  },
  _getInfo: function () {
    const _this = this;

    _this._infoPromise = fetch(_this._infoUrl)
      .then(function (response) {
        if (!response.ok) {
          console.error(`HTTP error! status: ${response.status}`);
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(function (data) {
        _this._assignInfo(data);
      })
      .catch(function (err) {
        console.error("Error fetching IIIF info:", err);
      });
  },
  _setQuality: function () {
    const _this = this;
    let profileToCheck = _this.profile;

    if (_this._explicitQuality) {
      return;
    }

    // If profile is an object
    if (typeof profileToCheck === "object") {
      profileToCheck = profileToCheck["@id"];
    }

    // Set the quality based on the IIIF compliance level
    switch (true) {
      case /^http:\/\/library.stanford.edu\/iiif\/image-api\/1.1\/compliance.html.*$/.test(
        profileToCheck,
      ):
        _this.options.quality = "native";
        break;
      // Assume later profiles and set to default
      default:
        _this.options.quality = "default";
        break;
    }
  },
  _setTileFormat: function (this: IiifTileFormatThis, info: IiifInfo) {
    if (this._explicitTileFormat) {
      return;
    }

    let formats: string[] | undefined;

    // IIIF Image API 2.x: formats listed in profile[1].formats
    const profile = info?.profile;
    if (Array.isArray(profile)) {
      const profileObject = profile.find(
        (entry: IiifProfileEntry) =>
          typeof entry === "object" && entry !== null,
      );
      if (profileObject?.formats && Array.isArray(profileObject.formats)) {
        formats = profileObject.formats;
      }
    }

    // Alternate location for formats (non-standard but seen in the wild)
    if (!formats && Array.isArray(info?.formats)) {
      formats = info.formats;
    }

    // IIIF Image API 3.x: extraFormats
    if (!formats && Array.isArray(info?.extraFormats)) {
      formats = info.extraFormats;
    }

    const selected = formats?.[0];
    if (typeof selected === "string") {
      const normalized = selected === "jpeg" ? "jpg" : selected;
      this.options.tileFormat = normalized;
    }
  },
  _infoToBaseUrl: function () {
    const url = this._infoUrl.split("?")[0];
    return url.replace("info.json", "");
  },
  _templateUrl: function () {
    const baseUrl = this._infoToBaseUrl();
    const template = baseUrl + IIIF_TILE_SUFFIX_FORMAT;
    return template;
  },
  _isValidTile: function (coords: Coords) {
    const _this = this;
    const zoom = _this._getZoomForUrl();
    const sizes = _this._tierSizes[zoom];
    const x = coords.x;
    const y = coords.y;
    if (zoom < 0 && x >= 0 && y >= 0) {
      return true;
    }

    if (!sizes) {
      return false;
    }
    if (x < 0 || sizes[0] <= x || y < 0 || sizes[1] <= y) {
      return false;
    } else {
      return true;
    }
  },
  _tileShouldBeLoaded: function (coords: Coords) {
    return this._isValidTile(coords);
  },
  _getInitialZoom: function (mapSize: Point) {
    const _this = this;
    let imageSize;
    const imageSizes = _this._imageSizes.length - 1;
    // Calculate an offset between the zoom levels and the array accessors
    const offset = imageSizes - _this.options.maxNativeZoom;
    for (let i = imageSizes; i >= 0; i--) {
      imageSize = _this._imageSizes[i];
      if (
        imageSize.x * MAX_BOUNDS_TOLERANCE < mapSize.x &&
        imageSize.y * MAX_BOUNDS_TOLERANCE < mapSize.y
      ) {
        return i - offset;
      }
    }
    return DEFAULT_ZOOM;
  },
});

tileLayer.iiif = function (url, options) {
  return new TileLayer.Iiif(url, options);
};
