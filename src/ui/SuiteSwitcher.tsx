import { useEffect, useState } from "react";
import { AudioLines, CalendarRange, Check, GitPullRequest, Highlighter, Search, Sun } from "lucide-react";
import { Command } from "cmdk";
import type { SuiteAppId, SuiteLinks } from "../lib/suite";
import { suiteCopy } from "../copy/suite";
import "./precise-ui.css";

const APPS = [
  { id: "personal", icon: Sun, shortcut: 1 },
  { id: "explain", icon: AudioLines, shortcut: 2 },
  { id: "pr", icon: GitPullRequest, shortcut: 3 },
  { id: "reader", icon: Highlighter, shortcut: 4 },
  { id: "campaign", icon: CalendarRange, shortcut: 5 },
] as const;

export default function SuiteSwitcher({ links, open, onOpenChange }: { links: SuiteLinks; open: boolean; onOpenChange: (open: boolean) => void }) {
  const copy = suiteCopy();
  const [search, setSearch] = useState("");
  useEffect(() => { if (!open) setSearch(""); }, [open]);
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={copy.switcher.label}
      className="p-command"
      overlayClassName="p-command-overlay"
      contentClassName="p-command-content"
    >
      <div className="p-command-search">
        <Search size={15} aria-hidden="true" />
        <Command.Input value={search} onValueChange={setSearch} aria-label={copy.switcher.label} placeholder={copy.switcher.searchPlaceholder} autoFocus />
        <kbd>esc</kbd>
      </div>
      <Command.List className="p-command-list">
        <Command.Empty>{copy.switcher.empty}</Command.Empty>
        {APPS.map(app => {
          const Icon = app.icon;
          const current = app.id === "explain";
          const href = current ? undefined : links[app.id as SuiteAppId];
          const disabled = current || !href;
          return (
            <Command.Item
              key={app.id}
              value={`${copy.apps[app.id].name} ${copy.apps[app.id].summary}`}
              disabled={disabled}
              aria-current={current ? "page" : undefined}
              className="p-command-item"
              onSelect={() => { if (href) window.location.href = href; }}
            >
              <span className={`p-app-icon p-app-${app.id}`}><Icon size={15} aria-hidden="true" /></span>
              <span className="p-command-app-name"><b>{copy.apps[app.id].name}</b><small>{copy.apps[app.id].summary}</small></span>
              <span className="p-command-app-state">
                {current ? <em>{copy.switcher.current} <Check size={12} aria-hidden="true" /></em> : !href ? <em>{copy.switcher.unlinked}</em> : null}
                <kbd>⌃{app.shortcut}</kbd>
              </span>
            </Command.Item>
          );
        })}
      </Command.List>
    </Command.Dialog>
  );
}
