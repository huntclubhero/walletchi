import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { MyPets } from "@/components/MyPets";

export const metadata: Metadata = {
  title: "My pets",
  description: "Sign in with your email to see, feed, and top up your WALLETCHI.",
};

export default function MePage() {
  return (
    <main className="relative" id="top">
      <SiteNav />
      <section className="mx-auto w-[min(1120px,90vw)] py-8 md:py-12">
        <MyPets />
      </section>
      <SiteFooter />
    </main>
  );
}
