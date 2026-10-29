import { PetSprite } from "./PetSprite";

/**
 * The hero pet: the pixel sprite, breathing and blinking. The eyelids are body-colored
 * overlays positioned over the eye cells (cols 5-6 and 9-10 of the 16-wide sprite) that
 * scale down to blink. Pure CSS, no images, no JS.
 */
export function PixelPet({ className = "" }: { className?: string }) {
  return (
    <div className={`pixel-pet ${className}`} role="img" aria-label="A chunky pixel pet, breathing and blinking">
      <div className="pp-breathe">
        <PetSprite className="pp-svg" />
        <span className="pp-lid pp-lid-l" />
        <span className="pp-lid pp-lid-r" />
      </div>
      <div className="pp-shadow" />
    </div>
  );
}
