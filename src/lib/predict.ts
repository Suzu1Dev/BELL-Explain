import { useCallback, useEffect, useState } from "react";

const KEY = "bell.predict";
/**
 * "Predict first" hides example results and animation changes until the
 * learner reveals them. On by default; remembered per browser.
 */
export function usePredictMode(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
  });
  useEffect(() => {
    const update = (event: StorageEvent) => { if (event.key === KEY) setEnabled(event.newValue !== "off"); };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  const change = useCallback((value: boolean) => {
    setEnabled(value);
    try { localStorage.setItem(KEY, value ? "on" : "off"); } catch { /* Works without storage for this visit. */ }
  }, []);
  return [enabled, change];
}
