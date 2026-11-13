import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, CalendarRange, GitPullRequest, Highlighter, Inbox } from "lucide-react";
import type { SuiteAppId, SuiteLinks } from "../lib/suite";
import { suiteCopy } from "../copy/suite";
import "./suite.css";

const APPS = [
  { id: "personal", icon: Inbox },
  { id: "explain", icon: BookOpen },
  { id: "pr", icon: GitPullRequest },
  { id: "reader", icon: Highlighter },
  { id: "campaign", icon: CalendarRange },
] as const;

export default function SuiteSwitcher({ links, mobile = false }: { links: SuiteLinks; mobile?: boolean }) {
  const copy = suiteCopy();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const move = (event: React.KeyboardEvent, direction: 1 | -1) => {
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLAnchorElement>("a[href]") || [])];
    if (!items.length) { menu.current?.focus(); return; }
    const current = items.indexOf(document.activeElement as HTMLAnchorElement);
    items[(current + direction + items.length) % items.length].focus();
  };
  return (
    <div className={`suite-switcher${mobile ? " suite-switcher-mobile" : ""}`} ref={root}>
      <button
        ref={button}
        type="button"
        className="suite-switcher-trigger"
        aria-label={copy.switcher.label}
        title={copy.switcher.label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => move(event, event.key === "ArrowDown" ? 1 : -1));
        }}
      >
        <span className="suite-grid-icon" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</span>
      </button>
      {open && (
        <div
          className="suite-switcher-menu"
          role="menu"
          aria-label={copy.switcher.menuLabel}
          ref={menu}
          tabIndex={-1}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); close(true); }
            if (event.key === "ArrowDown") move(event, 1);
            if (event.key === "ArrowUp") move(event, -1);
            if (event.key === "Tab") close();
          }}
        >
          <div className="suite-switcher-heading">{copy.switcher.heading}</div>
          {APPS.map(app => {
            const Icon = app.icon;
            const current = app.id === "explain";
            const href = current ? undefined : links[app.id as SuiteAppId];
            const content = <><Icon size={18} aria-hidden="true" /><span><b>{copy.apps[app.id].name}</b><small>{copy.apps[app.id].summary}</small></span>{current ? <em>{copy.switcher.current}</em> : href ? <ArrowUpRight size={14} aria-hidden="true" /> : <em>{copy.switcher.unlinked}</em>}</>;
            return current || !href
              ? <button key={app.id} type="button" role="menuitem" className="suite-app" disabled aria-current={current ? "page" : undefined}>{content}</button>
              : <a key={app.id} role="menuitem" className="suite-app" href={href} onClick={() => close()}>{content}</a>;
          })}
        </div>
      )}
    </div>
  );
}
