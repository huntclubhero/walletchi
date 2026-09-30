import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteNav, SiteFooter } from "@/components/SiteChrome";
import { CareClient } from "@/components/CareClient";
import { isCareAction } from "@/lib/care";

// Opened by the wallet-pass care link (feed/water/play/toy/explore). The sign-in gate + on-chain care
// happen client-side (CareClient), so this stays a thin, non-cached server shell.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Care for your WALLETCHI",
  robots: { index: false, follow: false },
};

export default async function CarePage({
  params,
}: {
  params: Promise<{ serial: string; action: string }>;
}) {
  const { serial, action } = await params;
  if (!isCareAction(action)) notFound();
  return (
    <>
      <SiteNav />
      <main className="mx-auto w-full max-w-[960px] px-4 py-10 sm:py-16">
        <CareClient serial={serial} action={action} />
      </main>
      <SiteFooter />
    </>
  );
}
