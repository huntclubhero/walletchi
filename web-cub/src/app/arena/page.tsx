import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { ArenaBoard } from "@/components/ArenaBoard";

export const metadata: Metadata = {
  title: "The Arena · live survival board",
  description:
    "The WALLETCHI survival board, live: the Pot, the survivors, the fallen, and the most devoted keepers. Last one alive takes everything.",
};

export default function ArenaPage() {
  return (
    <main className="relative">
      <SiteNav />
      <ArenaBoard />
      <SiteFooter />
    </main>
  );
}
