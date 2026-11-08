/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        luma: {
          50: "#f4f1ff",
          100: "#ebe5ff",
          200: "#d9ceff",
          300: "#bfa8ff",
          400: "#a17cff",
          500: "#8b5cf6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#3f1a7a",
          ink: "#0b0716",
          panel: "#120d22",
        },
      },
      fontFamily: {
        sans: [
          "Inter var",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      boxShadow: {
        glow: "0 0 40px -8px rgba(139, 92, 246, 0.55)",
        glass: "0 24px 60px -24px rgba(0, 0, 0, 0.85)",
        bubble: "0 10px 30px -12px rgba(124, 58, 237, 0.75)",
      },
      backgroundImage: {
        "luma-gradient": "linear-gradient(135deg, #a17cff 0%, #7c3aed 55%, #5b21b6 100%)",
        "luma-sheen":
          "linear-gradient(140deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.03) 42%, rgba(255,255,255,0) 100%)",
      },
      keyframes: {
        float: {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(0,-18px,0) scale(1.04)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        pulseRing: {
          "0%": { transform: "scale(0.9)", opacity: "0.7" },
          "70%": { transform: "scale(1.6)", opacity: "0" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
      },
      animation: {
        float: "float 14s ease-in-out infinite",
        shimmer: "shimmer 2.4s linear infinite",
        pulseRing: "pulseRing 2s cubic-bezier(0.4,0,0.6,1) infinite",
      },
    },
  },
  plugins: [],
};
