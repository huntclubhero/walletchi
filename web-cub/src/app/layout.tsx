import type { Metadata, Viewport } from "next";
import { Nunito, Pixelify_Sans } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { FrameShell } from "@/components/FrameShell";
import { MotionRoot } from "@/components/MotionRoot";
import { PrivyShell } from "@/components/PrivyShell";

// Display: Clash Display, self-hosted variable (Fontshare OFL).
const clash = localFont({
  src: "../fonts/ClashDisplay-Variable.woff2",
  variable: "--font-clash",
  weight: "400 700",
  display: "swap",
});

// LCD / pixel accents: eyebrows, counters, the frame labels, the ticker.
const pixel = Pixelify_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-pixel",
  display: "swap",
});

// Body: warm, readable.
const nunito = Nunito({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-nunito",
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.playwalletchi.com";

const TITLE = "WALLETCHI | The NFT is the wallet pass (Testnet Experience)";
const DESCRIPTION =
  "A pixel pet NFT that is its own Apple Wallet or Google Wallet pass: live state on the card, on-chain actions on the back, push updates when the chain changes. No app, no seed phrase. A live testnet demo of the Wallet Pass Extension for NFTs; tokens are fake and have no value.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s | WALLETCHI",
  },
  description: DESCRIPTION,
  applicationName: "WALLETCHI",
  keywords: ["wallet pass", "Apple Wallet", "Google Wallet", "NFT", "ERC-721", "ERC", "testnet", "virtual pet", "Robinhood Chain"],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "WALLETCHI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: "An NFT that is its own Apple Wallet or Google Wallet pass. Live testnet demo, no app, no seed phrase.",
  },
};

export const viewport: Viewport = {
  themeColor: "#e6f6f6",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${clash.variable} ${pixel.variable} ${nunito.variable}`}>
      <body>
        <MotionRoot />
        <FrameShell />
        <PrivyShell>{children}</PrivyShell>
      </body>
    </html>
  );
}
