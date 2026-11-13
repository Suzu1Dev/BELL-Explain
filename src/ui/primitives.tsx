import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export function Button({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`inline-flex min-h-8 items-center justify-center gap-2 rounded-md bg-explain px-3 text-ui font-medium text-explain-on shadow-panel hover:brightness-110 ${className}`} {...props}>{children}</button>;
}

export function SecondaryButton({ children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`inline-flex min-h-8 items-center justify-center gap-2 rounded-md border border-line-2 bg-raised px-3 text-ui text-text-2 shadow-panel hover:bg-raised-2 ${className}`} {...props}>{children}</button>;
}

export function Card({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-lg border border-line bg-raised shadow-panel ${className}`} {...props}>{children}</div>;
}

export function ListRow({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex min-h-8 items-center gap-3 border-b border-line px-3 py-1.5 text-ui last:border-b-0 hover:bg-fill-hover ${className}`} {...props}>{children}</div>;
}

export function Badge({ children, tone = "explain" }: { children: ReactNode; tone?: "explain" | "personal" | "pr" | "neutral" }) {
  return <span className={`inline-flex items-center rounded-xs px-1.5 py-0.5 text-micro ${tone === "neutral" ? "bg-raised-2 text-text-2" : `bg-${tone}-tint text-${tone}-text`}`}>{children}</span>;
}

export function EmptyState({ title, action, icon }: { title: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-line-2 px-6 py-10 text-center text-ui text-text-2">{icon}<p>{title}</p>{action}</div>;
}

export function LoadingState({ label = "載入中…" }: { label?: string }) {
  return <div role="status" className="flex items-center justify-center gap-2 py-10 text-ui text-text-2"><LoaderCircle size={16} className="animate-spin" />{label}</div>;
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-ui font-medium text-text-2">{children}</span>;
}
