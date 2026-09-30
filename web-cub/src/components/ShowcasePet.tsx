"use client";

import { useEffect, useRef, useState } from "react";
import { PetSprite, paletteForBody } from "./PetSprite";
import { petPortraitByToken } from "@/lib/brand";

/**
 * A colony tile. Shows a canonical-hue pixel pet immediately, then swaps to the real per-tokenId
 * portrait render (branded tile, number, rarity badge) the instant that image loads, once the
 * endpoint is live on the API. No broken-image flash while it is not. `hueIndex` seeds the
 * fallback so the tiles stay distinct today.
 */
export function ShowcasePet({ tokenId, hueIndex }: { tokenId: number; hueIndex: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Catch images that already finished loading before React attached onLoad (cache / fast localhost
  // / Strict Mode remount): onLoad would never fire for those, leaving the tile stuck on the swatch.
  useEffect(() => {
    const im = imgRef.current;
    if (im && im.complete) {
      if (im.naturalWidth > 0) setLoaded(true);
      else setFailed(true);
    }
  }, []);

  return (
    <div
      className="showcase-pet"
      style={{ position: "relative", ...(loaded ? { padding: 0, overflow: "hidden" } : {}) }}
    >
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={petPortraitByToken(tokenId)}
          alt={`Pet No. ${tokenId}`}
          width={108}
          height={108}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          // absolute + opacity (not display:none) so the lazy image still intersects + loads
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0 }}
        />
      )}
      {!loaded && <PetSprite size={84} palette={paletteForBody(hueIndex)} />}
    </div>
  );
}
