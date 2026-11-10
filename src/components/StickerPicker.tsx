import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

export const STICKER_PREFIX = "luma:sticker:v1:";
export const GIF_PREFIX = "luma:gif:v1:";
const STICKERS = ["🐱", "🦊", "🐻", "🐼", "🐸", "🐙", "🐧", "🦄", "🌈", "🌻", "🌙", "⚡", "💜", "💖", "✨", "🎉", "🥳", "😍", "🤗", "😎", "😭", "🔥", "💯", "🚀"];
type Gif = { id: string; title: string; images?: { fixed_width_small?: { url?: string } } };
const key = import.meta.env.VITE_GIPHY_API_KEY as string | undefined;
export function StickerPicker({ onSelect, onClose }: { onSelect: (body: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"stickers" | "gifs">("stickers");
  const [term, setTerm] = useState("");
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (tab !== "gifs" || !key) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError(false);
      try {
        const url = new URL(term.trim() ? "https://api.giphy.com/v1/gifs/search" : "https://api.giphy.com/v1/gifs/trending");
        url.searchParams.set("api_key", key); url.searchParams.set("limit", "24"); url.searchParams.set("rating", "pg-13");
        if (term.trim()) url.searchParams.set("q", term.trim());
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("GIF search failed");
        const result = await response.json();
        setGifs((result.data as Gif[]).filter((gif) => /^[a-zA-Z0-9]{1,40}$/.test(gif.id)));
      } catch (err) { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tab, term]);
  return <div className="glass-strong absolute bottom-[calc(100%-4px)] left-3 right-3 z-20 mb-1 max-w-sm rounded-2xl p-3 sm:left-5">
    <div className="flex items-center gap-2"><button onClick={() => setTab("stickers")} className={`rounded-full px-3 py-1.5 text-xs ${tab === "stickers" ? "bg-luma-500/30 text-white" : "text-slate-400"}`}>Stickers</button><button onClick={() => setTab("gifs")} className={`rounded-full px-3 py-1.5 text-xs ${tab === "gifs" ? "bg-luma-500/30 text-white" : "text-slate-400"}`}>GIFs</button><button onClick={onClose} className="btn-icon ml-auto h-8 w-8" aria-label="Close sticker picker"><X className="h-4 w-4" /></button></div>
    {tab === "stickers" ? <div className="mt-3 grid grid-cols-6 gap-1">{STICKERS.map((sticker) => <button key={sticker} onClick={() => onSelect(STICKER_PREFIX + sticker)} className="grid h-12 place-items-center rounded-xl text-3xl transition-transform hover:scale-110 hover:bg-white/10" aria-label={`Send ${sticker} sticker`}>{sticker}</button>)}</div> : !key ? <p className="py-8 text-center text-xs leading-relaxed text-slate-400">GIF search needs a free Giphy API key. The built-in stickers work without one.</p> : <>
      <label className="relative mt-3 block"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" /><input value={term} onChange={(e) => setTerm(e.target.value)} className="field py-2 pl-9 text-xs" placeholder="Search GIFs" /></label>
      <div className="mt-2 grid max-h-60 grid-cols-3 gap-1.5 overflow-y-auto">{loading ? <Loader2 className="m-5 h-4 w-4 animate-spin text-slate-400" /> : error ? <p className="col-span-3 p-4 text-xs text-slate-400">GIF search is unavailable right now.</p> : gifs.map((gif) => <button key={gif.id} onClick={() => onSelect(GIF_PREFIX + gif.id)} className="overflow-hidden rounded-lg bg-white/5" aria-label={`Send GIF ${gif.title}`}><img src={gif.images?.fixed_width_small?.url} alt={gif.title} className="h-20 w-full object-cover" loading="lazy" /></button>)}</div>
      <p className="mt-2 text-right text-[10px] text-slate-500">Powered by GIPHY</p>
    </>}
  </div>;
}
