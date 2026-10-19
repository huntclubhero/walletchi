"use client";

import { useEffect } from "react";

/**
 * One client component that owns all page motion, native-scroll only (no scroll-jacking):
 * - staggered reveal-on-scroll for [data-reveal] via IntersectionObserver
 * - count-up for [data-countup] when it enters view
 * - compositor-friendly parallax for [data-parallax] (transform only, runs on mobile)
 * - the top scroll-progress bar
 * Everything degrades to a static, fully-visible page under prefers-reduced-motion.
 */
export function MotionRoot() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.body.classList.add("is-ready");

    const revealEls = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const countEls = Array.from(document.querySelectorAll<HTMLElement>("[data-countup]"));

    if (reduce) {
      revealEls.forEach((el) => el.classList.add("is-in"));
      countEls.forEach((el) => (el.textContent = formatCount(el)));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const el = e.target as HTMLElement;
          if (el.hasAttribute("data-reveal")) el.classList.add("is-in");
          if (el.hasAttribute("data-countup")) runCount(el);
          io.unobserve(el);
        });
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    revealEls.forEach((el) => io.observe(el));
    countEls.forEach((el) => io.observe(el));

    const parallaxEls = Array.from(document.querySelectorAll<HTMLElement>("[data-parallax]"));
    const progress = document.getElementById("wlc-progress");
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY || window.pageYOffset;
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (progress) progress.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
        const vh = window.innerHeight;
        parallaxEls.forEach((el) => {
          const factor = parseFloat(el.dataset.parallax || "0");
          const rect = el.getBoundingClientRect();
          const center = rect.top + rect.height / 2 - vh / 2;
          el.style.transform = `translate3d(0, ${(center * factor).toFixed(1)}px, 0)`;
        });
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return null;
}

function formatCount(el: HTMLElement): string {
  const target = parseFloat(el.dataset.countup || "0");
  return (el.dataset.prefix || "") + Math.round(target).toLocaleString("en-US") + (el.dataset.suffix || "");
}

function runCount(el: HTMLElement) {
  const target = parseFloat(el.dataset.countup || "0");
  const prefix = el.dataset.prefix || "";
  const suffix = el.dataset.suffix || "";
  const dur = 1300;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + Math.round(target * eased).toLocaleString("en-US") + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
