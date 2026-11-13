import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

export default function Select({ label, value, options, onChange, disabled = false, className = "" }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.value === value);
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={`p-select-trigger ${className}`} aria-label={label} disabled={disabled}>
          <span>{selected?.label || value || "—"}</span><ChevronDown size={13} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="p-select-content" align="start" sideOffset={5} onOpenAutoFocus={event => {
          event.preventDefault();
          list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"], button:not(:disabled)')?.focus();
        }}>
          <div ref={list} className="p-select-list" role="listbox" aria-label={label} onKeyDownCapture={move}>
            {options.map(option => (
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                key={option.value}
                onClick={() => { onChange(option.value); setOpen(false); }}
              >
                <span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
