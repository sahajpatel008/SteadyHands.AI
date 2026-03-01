import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { getActionScript } from "../lib/actionExecutor";
import { getExtractionScript } from "../lib/contentExtractor";
import { logRenderer } from "../../shared/logger";
import type {
  ActionExecutionResult,
  BrowserAction,
  PageObservation,
} from "../../shared/types";

type BrowserPaneProps = {
  initialUrl: string;
  textLimit: number;
  enableHighlight: boolean;
  onUrlChange: (url: string) => void;
};

export type BrowserPaneHandle = {
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  refresh: () => void;
  canGoBack: () => boolean;
  observe: () => Promise<PageObservation>;
  act: (action: BrowserAction) => Promise<ActionExecutionResult>;
};

export const BrowserPane = forwardRef<BrowserPaneHandle, BrowserPaneProps>(
  ({ initialUrl, onUrlChange, textLimit, enableHighlight }, ref) => {
    const webviewRef = useRef<HTMLElement | null>(null);
    const lastObservationRef = useRef<PageObservation | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      const webview = webviewRef.current as any;
      if (!webview) return;

      const onStart = () => setLoading(true);
      const onStop = () => setLoading(false);
      const onNavigate = (event: any) => onUrlChange(event.url);

      webview.addEventListener("did-start-loading", onStart);
      webview.addEventListener("did-stop-loading", onStop);
      webview.addEventListener("did-navigate", onNavigate);
      webview.addEventListener("did-navigate-in-page", onNavigate);

      return () => {
        webview.removeEventListener("did-start-loading", onStart);
        webview.removeEventListener("did-stop-loading", onStop);
        webview.removeEventListener("did-navigate", onNavigate);
        webview.removeEventListener("did-navigate-in-page", onNavigate);
      };
    }, [onUrlChange]);

    useImperativeHandle(ref, () => {
      const getWebview = () => webviewRef.current as any;

      return {
        navigate: (url) => {
          logRenderer("BrowserPane", "navigate", { url });
          const webview = getWebview();
          if (webview) webview.loadURL(url);
        },
        goBack: () => {
          const webview = getWebview();
          if (webview?.canGoBack()) webview.goBack();
        },
        canGoBack: () => {
          const webview = getWebview();
          return !!(webview?.canGoBack?.());
        },
        goForward: () => {
          const webview = getWebview();
          if (webview?.canGoForward()) webview.goForward();
        },
        refresh: () => {
          const webview = getWebview();
          if (webview) webview.reload();
        },
        observe: async () => {
          logRenderer("BrowserPane", "observe start");
          const webview = getWebview();
          if (!webview) {
            logRenderer("BrowserPane", "observe error: webview not mounted");
            throw new Error("Browser webview is not mounted.");
          }
          const extracted = await webview.executeJavaScript(
            getExtractionScript(textLimit),
            true,
          );
          logRenderer("BrowserPane", "observe extracted", { title: (extracted as PageObservation).title, url: (extracted as PageObservation).url, elements: (extracted as PageObservation).elements?.length });
          const observation = {
            ...extracted,
            // Vision is disabled; skip expensive capturePage() work.
            screenshotDataUrl: null,
            observedAt: new Date().toISOString(),
          };
          lastObservationRef.current = observation as PageObservation;
          return observation;
        },
        act: async (action) => {
          logRenderer("BrowserPane", "act start", action);
          const webview = getWebview();
          if (!webview) {
            logRenderer("BrowserPane", "act error: webview not mounted");
            return {
              ok: false,
              message: "Browser webview is not mounted.",
              action,
            };
          }
          const fallbackHint =
            action.type === "navigate"
              ? null
              : lastObservationRef.current?.elements?.find((el) => el.id === action.elementId) ?? null;
          const result = await webview.executeJavaScript(
            getActionScript(action, enableHighlight, fallbackHint),
            true,
          );
          logRenderer("BrowserPane", "act result", result);
          return result as ActionExecutionResult;
        },
      };
    }, [enableHighlight, textLimit]);

    return (
      <div className="browserPane">
        {loading && <div className="browserLoading">Loading page...</div>}
        <webview
          ref={(node) => {
            webviewRef.current = node;
          }}
          src={initialUrl}
          allowpopups="true"
          webpreferences="contextIsolation=yes,sandbox=no"
          className="browserWebview"
        />
      </div>
    );
  },
);

BrowserPane.displayName = "BrowserPane";
