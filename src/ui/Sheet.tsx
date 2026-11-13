import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { SecondaryButton } from "./primitives";

export default function Sheet({ open, onOpenChange, title, children, className = "", closeLabel = "關閉" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const dragControls = useDragControls();
  if (open && !returnFocus.current) returnFocus.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    if (!open) return;
    return () => {
      returnFocus.current?.focus({ preventScroll: true });
      returnFocus.current = null;
    };
  }, [open]);
  const contentRef = useCallback((sheet: HTMLDivElement | null) => {
    if (!sheet) return;
    let frame = 0;
    const reveal = (target: HTMLElement) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!target.isConnected || !sheet.contains(target)) return;
        if (target !== sheet && target.closest(".p-sheet-heading, .ms-actions")) return;
        const sheetRect = sheet.getBoundingClientRect();
        const heading = sheet.querySelector<HTMLElement>(".p-sheet-heading");
        const footer = sheet.querySelector<HTMLElement>(".ms-actions");
        const top = heading ? heading.getBoundingClientRect().bottom : sheetRect.top + sheet.clientTop;
        const bottom = footer ? footer.getBoundingClientRect().top : sheetRect.bottom;
        const rect = target.getBoundingClientRect();
        let delta = 0;
        if (rect.top < top) delta = Math.floor(rect.top - top);
        else if (rect.bottom > bottom) delta = Math.ceil(rect.bottom - bottom);
        if (delta) sheet.scrollTop += delta;
      });
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      reveal(target === sheet ? sheet.querySelector<HTMLElement>(".ms-message") ?? target : target);
    };
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const message = node.matches(".ms-message") ? node : node.querySelector(".ms-message");
        if (message) reveal(message as HTMLElement);
      }
    });
    sheet.addEventListener("focusin", onFocus);
    observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      sheet.removeEventListener("focusin", onFocus);
    };
  }, []);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay className="p-sheet-overlay" asChild>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content
              ref={contentRef}
              className={`p-sheet-content ${className}`}
              aria-describedby={undefined}
              onCloseAutoFocus={event => event.preventDefault()}
              asChild
            >
              <motion.div
                drag="y"
                dragListener={false}
                dragControls={dragControls}
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.7 }}
                onDragEnd={(_event, info) => { if (info.offset.y > 100 || info.velocity.y > 500) onOpenChange(false); }}
                initial={{ opacity: 0, y: 12, scale: .98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: .98 }}
                transition={{ duration: .24, ease: [0.16, 1, 0.3, 1] }}
                style={{ touchAction: "pan-y" }}
              >
                <div className="p-sheet-heading" onPointerDown={event => { if (!(event.target as HTMLElement).closest("button")) dragControls.start(event); }}>
                  <Dialog.Title>{title}</Dialog.Title>
                  <Dialog.Close asChild><SecondaryButton className="h-8 w-8 px-0" aria-label={closeLabel}><X size={16} /></SecondaryButton></Dialog.Close>
                </div>
                {children}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
