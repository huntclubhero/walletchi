"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * A scannable QR for a wallet/account address, so a phone wallet (MetaMask,
 * Rainbow, etc.) can point-and-send CARE to the pet's 6551 account without
 * anyone copying a 0x string by hand. Rendered client-side to a data URL; if
 * generation ever fails it renders nothing (the copy button stays the fallback).
 */
export function AddressQR({ value, size = 150 }: { value: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, {
      margin: 1,
      width: size * 2, // 2x for crisp rendering on retina
      color: { dark: "#173a42", light: "#ffffff" },
    })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc("");
      });
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt="Scan this code to send CARE to your pet's account"
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: 14, background: "#fff", padding: 8, boxShadow: "0 2px 10px rgba(23,58,66,0.12)" }}
    />
  );
}
