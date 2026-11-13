import { ChevronLeft, X } from "lucide-react";
import { handoffFromLine, suiteBackHref, type ExplainHandoff, type SuiteLinks } from "../lib/suite";
import { fill, suiteCopy } from "../copy/suite";

export default function SuiteSourceBanner({
  ready,
  handoff,
  links,
  currentHostname = "",
  error = "",
  onDismissError,
}: {
  ready: boolean;
  handoff?: ExplainHandoff;
  links: SuiteLinks;
  currentHostname?: string;
  error?: string;
  onDismissError?: () => void;
}) {
  const copy = suiteCopy();
  const linkedSource = ready && handoff?.from && links[handoff.from];
  const source = !ready
    ? copy.handoff.checking
    : linkedSource
      ? handoffFromLine(handoff)
      : copy.handoff.defaultSource;
  const back = ready && handoff ? suiteBackHref(links, handoff.from, handoff.back, currentHostname) : undefined;
  const backName = handoff?.from ? copy.apps[handoff.from].name : copy.apps.personal.name;
  return (
    <section className="suite-source-banner" aria-label={copy.handoff.bannerAria} aria-busy={!ready}>
      <div className="suite-source-copy">
        <span className="suite-source-chip" role={!ready ? "status" : undefined}><bdi>{source}</bdi></span>
        {error && <span className="suite-source-error" role="alert">{error}{onDismissError && <button type="button" className="suite-source-error-close" aria-label={copy.handoff.dismissErrorAria} title={copy.handoff.dismissErrorTitle} onClick={onDismissError}><X size={14} aria-hidden="true" /></button>}</span>}
        {handoff?.truncated && <span role="status">{copy.handoff.truncated}</span>}
      </div>
      {back && <a className="suite-back-link" href={back}><ChevronLeft size={15} aria-hidden="true" /><bdi>{fill(copy.handoff.back, { name: backName })}</bdi></a>}
    </section>
  );
}
