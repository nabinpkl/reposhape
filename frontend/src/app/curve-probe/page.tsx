"use client";

import dynamic from "next/dynamic";

const CurveProbe = dynamic(
  () => import("./probe").then((m) => m.CurveProbe),
  { ssr: false },
);

export default function CurveProbePage() {
  return <CurveProbe />;
}
