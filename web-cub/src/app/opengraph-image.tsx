import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "WALLETCHI Testnet Experience | The NFT is the wallet pass";

// OG: cream + river split, the Testnet Experience stamp, and a big chunky pixel pet face.
export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          alignItems: "center",
          background: "#fff8f1",
          padding: 80,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", width: 660 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 12, height: 12, borderRadius: 12, background: "#33a7b5" }} />
            <div style={{ fontSize: 26, color: "#1c7f8f", letterSpacing: 5, fontWeight: 700 }}>WALLETCHI</div>
            <div style={{ fontSize: 20, color: "#163f52", background: "#ffd9c9", borderRadius: 8, padding: "4px 12px", letterSpacing: 3, fontWeight: 700 }}>
              TESTNET EXPERIENCE
            </div>
          </div>
          <div style={{ fontSize: 70, fontWeight: 800, color: "#264a44", lineHeight: 1.06, marginTop: 20 }}>
            The NFT is the wallet pass.
          </div>
          <div style={{ fontSize: 27, color: "#4a6b64", marginTop: 22 }}>
            Live on the card. Actions on the back. No app, no seed phrase.
          </div>
        </div>

        {/* solid river block on the right, the pet on top of it */}
        <div style={{ position: "absolute", right: 0, top: 0, width: 440, height: 630, background: "#163f52", display: "flex" }} />
        {/* chunky pixel pet face */}
        <div style={{ position: "absolute", right: 110, top: 180, display: "flex", width: 300, height: 280 }}>
          <div style={{ position: "absolute", left: 138, top: 0, width: 26, height: 30, background: "#a68fd8" }} />
          <div style={{ position: "absolute", left: 40, top: 26, width: 220, height: 200, borderRadius: 40, background: "#7fd0cb" }} />
          <div style={{ position: "absolute", left: 104, top: 96, width: 26, height: 46, background: "#241f38" }} />
          <div style={{ position: "absolute", left: 170, top: 96, width: 26, height: 46, background: "#241f38" }} />
          <div style={{ position: "absolute", left: 110, top: 100, width: 8, height: 8, background: "#ffffff" }} />
          <div style={{ position: "absolute", left: 176, top: 100, width: 8, height: 8, background: "#ffffff" }} />
          <div style={{ position: "absolute", left: 70, top: 150, width: 34, height: 22, borderRadius: 8, background: "#ff9d82" }} />
          <div style={{ position: "absolute", left: 196, top: 150, width: 34, height: 22, borderRadius: 8, background: "#ff9d82" }} />
          <div style={{ position: "absolute", left: 132, top: 158, width: 36, height: 14, borderRadius: 8, background: "#e07a72" }} />
          <div style={{ position: "absolute", left: 108, top: 180, width: 84, height: 40, borderRadius: 20, background: "#f6eede" }} />
        </div>
      </div>
    ),
    { ...size },
  );
}
