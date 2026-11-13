import { useState } from "react";
import { CornerDownRight, CornerUpLeft, FileText, Link2 } from "lucide-react";
import {
  formatRelationTooltip,
  formatShowRemaining,
  relatedNotesCopy,
  resolveCodeRelatedNotesLocale,
} from "../copy/code-related-notes";
import type { RelatedNote } from "../lib/related-notes";
import MathText from "./MathText";

const icons = { "links-to": FileText, "linked-from": CornerUpLeft, continues: CornerUpLeft, "continued-by": CornerDownRight };

const SHOWN = 8;

export default function RelatedNotes({ items, open, title }: { items: RelatedNote[]; open: (id: string, section?: string) => void; title?: string }) {
  const locale = resolveCodeRelatedNotesLocale();
  const copy = relatedNotesCopy(locale);
  const heading = title ?? copy.heading;
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const notes = new Set(items.map((item) => item.lessonId)).size;
  return (
    <section className="related-notes" aria-label={heading}>
      <h3><Link2 size={15} aria-hidden="true" />{heading}<small>{notes}</small></h3>
      <ul>
        {(all ? items : items.slice(0, SHOWN)).map((item) => {
          const Icon = icons[item.kind];
          return (
            <li key={`${item.kind}:${item.lessonId}:${item.sectionId || ""}`}>
              <button type="button" onClick={() => open(item.lessonId, item.sectionId)} title={formatRelationTooltip(item, locale)}>
                <Icon size={13} aria-hidden="true" />
                <strong><MathText text={item.title} /></strong>
              </button>
            </li>
          );
        })}
      </ul>
      {items.length > SHOWN && (
        <button type="button" className="related-more" onClick={() => setAll((value) => !value)} aria-expanded={all}>
          {all ? copy.collapse : formatShowRemaining(items.length - SHOWN, locale)}
        </button>
      )}
    </section>
  );
}
