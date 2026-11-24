import { useCallback, useEffect, useRef, useState } from 'react';

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

interface WindowWithPiP extends Window {
  documentPictureInPicture?: DocumentPictureInPictureApi;
}

export interface FloatingWindowState {
  isOpen: boolean;
  isSupportedPiP: boolean;
  portalContainer: HTMLElement | null;
  toggleFloating: () => Promise<void>;
}

function copyStylesInto(targetDoc: Document): void {
  const nodes = document.querySelectorAll('link[rel="stylesheet"], style');
  for (const node of nodes) {
    targetDoc.head.appendChild(targetDoc.importNode(node, true));
  }
}

export function useFloatingWindow(): FloatingWindowState {
  const pipWinRef = useRef<Window | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  const isSupportedPiP =
    typeof window !== 'undefined' &&
    Boolean((window as WindowWithPiP).documentPictureInPicture?.requestWindow);

  useEffect(() => {
    return () => {
      if (pipWinRef.current && !pipWinRef.current.closed) {
        pipWinRef.current.close();
      }
      pipWinRef.current = null;
    };
  }, []);

  const toggleFloating = useCallback(async () => {
    if (pipWinRef.current && !pipWinRef.current.closed) {
      pipWinRef.current.close();
      pipWinRef.current = null;
      setPortalContainer(null);
      return;
    }

    const pipApi = (window as WindowWithPiP).documentPictureInPicture;
    if (pipApi?.requestWindow) {
      try {
        const pipWin = await pipApi.requestWindow({ width: 380, height: 240 });
        pipWinRef.current = pipWin;
        pipWin.document.title = 'Pixel Agents · 懸浮監控';
        copyStylesInto(pipWin.document);
        pipWin.document.body.className =
          'm-0 w-full h-full overflow-hidden bg-bg text-text font-pixel';
        const mount = pipWin.document.createElement('div');
        mount.id = 'floating-root';
        mount.className = 'w-full h-full';
        pipWin.document.body.appendChild(mount);
        setPortalContainer(mount);

        pipWin.addEventListener('pagehide', () => {
          pipWinRef.current = null;
          setPortalContainer(null);
        });
        return;
      } catch {
        /* Fall through to compact popup fallback if PiP request is denied */
      }
    }

    const url = new URL(window.location.href);
    url.searchParams.set('compact', '1');
    window.open(url.toString(), 'pixel-agents-floating', 'popup,width=380,height=240');
  }, []);

  return {
    isOpen: portalContainer !== null,
    isSupportedPiP,
    portalContainer,
    toggleFloating,
  };
}
