import { motion } from "framer-motion";
const COLORS = ["#c4b5fd", "#a78bfa", "#67e8f9", "#f9a8d4", "#fde68a"];
/** Decorative, transient, and only mounted for a live celebration. */
export function Confetti() {
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-30 overflow-hidden">{Array.from({ length: 24 }, (_, i) => <motion.span key={i} className="absolute top-[35%] h-2 w-1.5 rounded-sm" style={{ left: `${15 + (i * 37 % 70)}%`, backgroundColor: COLORS[i % COLORS.length] }} initial={{ opacity: 1, y: 0, rotate: 0, scale: .6 }} animate={{ opacity: [1, 1, 0], y: [-10, -110 - (i % 5) * 18, 280], x: (i % 2 ? 1 : -1) * (40 + i * 4), rotate: 400 + i * 17, scale: 1 }} transition={{ duration: 2.2 + (i % 4) * .15, ease: "easeOut" }} />)}</div>;
}
