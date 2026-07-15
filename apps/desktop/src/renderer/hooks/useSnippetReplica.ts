import type { SnippetListItem } from "../../ipc/contracts.ts";
import { useEffect, useState } from "react";

export function useSnippetReplica() {
  const [items, setItems] = useState<ReadonlyArray<SnippetListItem>>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let changed = false;
    let mounted = true;
    const unsubscribe = window.ipc.snippets.onChanged((next) => {
      changed = true;
      if (mounted) {
        setItems(next);
        setIsLoading(false);
      }
    });
    void window.ipc.snippets.list().then(
      (next) => {
        if (mounted && !changed) setItems(next);
        if (mounted) setIsLoading(false);
      },
      () => {
        if (mounted) setIsLoading(false);
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { isLoading, items };
}
