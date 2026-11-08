import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect } from "react";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = "max-w-md",
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[150] grid place-items-center p-4">
          <motion.div
            className="absolute inset-0 bg-luma-ink/70 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className={`glass-panel relative z-10 w-full ${maxWidth} max-h-[88vh] overflow-y-auto rounded-[28px] no-scrollbar`}
          >
            <div className="relative z-10 flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
              <div>
                <h2 className="text-[17px] font-semibold tracking-tight text-white">{title}</h2>
                {subtitle && <p className="mt-0.5 text-[13px] text-slate-400">{subtitle}</p>}
              </div>
              <button onClick={onClose} className="btn-icon h-9 w-9" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative z-10 px-5 py-5">{children}</div>
            {footer && (
              <div className="relative z-10 border-t border-white/[0.07] px-5 py-4">{footer}</div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
