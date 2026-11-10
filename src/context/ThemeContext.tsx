import { createContext, useContext, useEffect, useMemo, useState } from "react";

type Theme = "dark" | "light";
export type Accent = "violet" | "azure" | "emerald" | "rose" | "amber";
export type MsgSize = "small" | "medium" | "large";
export type Wallpaper = "default" | "stars" | "aurora";

type Ctx = {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
  accent: Accent;
  setAccent: (a: Accent) => void;
  msgSize: MsgSize;
  setMsgSize: (s: MsgSize) => void;
  wallpaper: Wallpaper;
  setWallpaper: (w: Wallpaper) => void;
};

const ThemeContext = createContext<Ctx>({
  theme: "dark",
  toggle: () => {},
  setTheme: () => {},
  accent: "violet",
  setAccent: () => {},
  msgSize: "medium",
  setMsgSize: () => {},
  wallpaper: "default",
  setWallpaper: () => {},
});

function read<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const saved = localStorage.getItem(key) as T | null;
  return saved && allowed.includes(saved) ? saved : fallback;
}

const ACCENTS: readonly Accent[] = ["violet", "azure", "emerald", "rose", "amber"];
const SIZES: readonly MsgSize[] = ["small", "medium", "large"];
const WALLS: readonly Wallpaper[] = ["default", "stars", "aurora"];

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    read("luma-theme", "dark", ["dark", "light"] as const)
  );
  const [accent, setAccent] = useState<Accent>(() => read("luma-accent", "violet", ACCENTS));
  const [msgSize, setMsgSize] = useState<MsgSize>(() => read("luma-msgsize", "medium", SIZES));
  const [wallpaper, setWallpaper] = useState<Wallpaper>(() => read("luma-wallpaper", "default", WALLS));

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
    root.style.colorScheme = theme;
    root.dataset.accent = accent;
    root.dataset.msgsize = msgSize;
    root.dataset.wallpaper = wallpaper;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0b0716" : "#f6f3ff");
    localStorage.setItem("luma-theme", theme);
    localStorage.setItem("luma-accent", accent);
    localStorage.setItem("luma-msgsize", msgSize);
    localStorage.setItem("luma-wallpaper", wallpaper);
  }, [theme, accent, msgSize, wallpaper]);

  const value = useMemo<Ctx>(
    () => ({
      theme,
      setTheme: setThemeState,
      toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
      accent,
      setAccent,
      msgSize,
      setMsgSize,
      wallpaper,
      setWallpaper,
    }),
    [theme, accent, msgSize, wallpaper]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => useContext(ThemeContext);
