import { useCallback, useEffect, useState } from "react";
import type { RecallState } from "../../../shared/learning";
import { api } from "../../lib/api";

export function useRecalls(lessonId: string) {
  const [states, setStates] = useState<Record<string, RecallState>>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setStates({});
    api.recall(lessonId)
      .then(items => {
        if (!active) return;
        setStates(Object.fromEntries(items.map(item => [item.stepId, item])));
        setLoading(false);
      })
      .catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [lessonId]);
  const onRated = useCallback((state: RecallState) => {
    setStates(current => ({ ...current, [state.stepId]: state }));
  }, []);
  return { states, loading, onRated };
}
