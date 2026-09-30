import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Favicon: a chunky pixel pet face on a soft dawn tile.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: "linear-gradient(160deg,#e6f6f6,#f1ecfb)",
          borderRadius: 8,
        }}
      >
        <div style={{ position: "absolute", left: 14, top: 2, width: 4, height: 5, background: "#a68fd8" }} />
        <div style={{ position: "absolute", left: 5, top: 6, width: 22, height: 20, borderRadius: 6, background: "#7fd0cb" }} />
        <div style={{ position: "absolute", left: 11, top: 13, width: 3, height: 5, background: "#241f38" }} />
        <div style={{ position: "absolute", left: 18, top: 13, width: 3, height: 5, background: "#241f38" }} />
        <div style={{ position: "absolute", left: 8, top: 19, width: 4, height: 3, borderRadius: 2, background: "#ff9d82" }} />
        <div style={{ position: "absolute", left: 20, top: 19, width: 4, height: 3, borderRadius: 2, background: "#ff9d82" }} />
        <div style={{ position: "absolute", left: 14, top: 20, width: 4, height: 2, borderRadius: 2, background: "#e07a72" }} />
      </div>
    ),
    { ...size },
  );
}
