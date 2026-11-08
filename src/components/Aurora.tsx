import { motion } from "framer-motion";

/** Ambient violet aurora used behind the app for depth. */
export function Aurora() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <motion.div
        className="absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full bg-violet-600/25 blur-[130px]"
        animate={{ x: [0, 60, -20, 0], y: [0, 40, 10, 0], scale: [1, 1.08, 0.98, 1] }}
        transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -right-32 top-1/4 h-[30rem] w-[30rem] rounded-full bg-indigo-500/20 blur-[130px]"
        animate={{ x: [0, -50, 20, 0], y: [0, 60, -20, 0], scale: [1, 1.12, 1, 1] }}
        transition={{ duration: 32, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-[-14rem] left-1/3 h-[32rem] w-[32rem] rounded-full bg-fuchsia-600/15 blur-[140px]"
        animate={{ x: [0, 40, -30, 0], y: [0, -40, 20, 0], scale: [1, 1.06, 1, 1] }}
        transition={{ duration: 38, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,rgba(255,255,255,0.05),transparent_70%)]" />
    </div>
  );
}
