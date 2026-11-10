import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCw, ShieldAlert } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || "An unexpected UI error occurred.",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Luma ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="grid h-full w-full place-items-center bg-luma-ink px-6 text-center text-slate-100">
        <div className="glass-panel max-w-md rounded-3xl p-6">
          <ShieldAlert className="mx-auto h-10 w-10 text-rose-300" />
          <h1 className="mt-4 text-lg font-semibold text-white">Something went wrong</h1>
          <p className="mt-2 break-words text-[13px] leading-relaxed text-slate-400">
            {this.state.message}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-primary mt-5 w-full"
          >
            <RotateCw className="h-4 w-4" />
            Reload Luma
          </button>
        </div>
      </div>
    );
  }
}
