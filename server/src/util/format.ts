// Display helpers. No em dashes or double hyphens anywhere in user-facing copy.

// 0x1234...abcd short form for wallet + token-bound account display.
export function shortHex(addr: string | null): string {
  if (!addr) return "Minting";
  if (!addr.startsWith("0x") || addr.length <= 11) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
