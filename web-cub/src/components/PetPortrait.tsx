"use client";

import { useEffect, useRef, useState } from "react";
import { PetSprite, paletteFromSeed } from "./PetSprite";
import { petImageUrl } from "@/lib/brand";

/**
 * Shows a pet's ACTUAL image: server-dev2's square portrait render by serial (reflects the pet's
 * live mood + toys, matches the wallet pass + metadata). Shows a canonical-hue pixel variant
 * immediately and swaps to the real render the moment it loads, so there is never a broken-image
 * flash while the endpoint is not yet live.
 */
export function PetPortrait({
  serial,
  seed,
  width = 280,
  className = "",
  alt = "Your pet",
}: {
  serial?: string | null;
  seed?: string | number | null;
  width?: number;
  className?: string;
  /** Accessible name, e.g. "Pet No. 1042". Defaults to "Your pet". */
  alt?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const fallbackSeed = seed ?? serial ?? "walletchi";
  const src = serial ? petImageUrl(serial) : "";

  // Reset per src (a serial change must never leave a stale empty box), then
  // handle images that finished before React attached onLoad (cache / fast
  // localhost / Strict Mode).
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    const im = imgRef.current;
    if (im && im.complete) {
      if (im.naturalWidth > 0) setLoaded(true);
      else setFailed(true);
    }
  }, [src]);

  return (
    <div
      className={className}
      style={{
        width,
        maxWidth: "100%",
        aspectRatio: "1 / 1",
        position: "relative",
        borderRadius: 22,
        overflow: "hidden",
        background: loaded ? undefined : "linear-gradient(160deg,#eaf6f7,#fdeee6)",
        boxShadow: loaded
          ? "0 16px 30px -16px rgba(47,125,122,0.45)"
          : "inset 0 0 0 2px rgba(164,143,214,0.2)",
      }}
      role="img"
      aria-label={alt}
    >
      {src && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          // opacity (not display:none) so a lazy image still intersects + loads
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0 }}
        />
      )}
      {!loaded && (
        <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center" }}>
          <PetSprite size={Math.round(width * 0.6)} palette={paletteFromSeed(fallbackSeed)} />
        </div>
      )}
    </div>
  );
}
