// ABOUTME: Child-webview browser panes for the file-preview panel (spec 2026-09-22).
// ABOUTME: External webviews carry no capability init script; URL policy denies the host origin.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl,
};

/// Whether a URL may load inside a browser pane. Only http(s) is allowed and
/// the origin must never be the Picot host origin — an external page jumping
/// back to host origin must not reach the owner WebView's context.
pub fn pane_url_allowed(url: &Url, host_origin: &str) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    url.origin().ascii_serialization() != host_origin
}

/// Tauri-managed state so exit/window-destroy hooks can reach the runtime.
pub struct BrowserPaneState(pub std::sync::Arc<BrowserPaneRuntime>);

pub struct BrowserPaneRuntime {
    app: AppHandle,
    host_origin: String,
    panes: Mutex<HashMap<String, Webview>>,
}

#[derive(Debug)]
pub struct PaneRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserPaneRuntime {
    pub fn new(app: AppHandle, host_origin: &str) -> Self {
        Self {
            app,
            host_origin: host_origin.to_string(),
            panes: Mutex::new(HashMap::new()),
        }
    }

    /// Create a child webview inside `window_label` at `rect`. The webview is
    /// created hidden-at-position by `add_child` (correct rect from the first
    /// frame) and only shown on demand by the WebView layer.
    pub fn create(
        &self,
        pane_id: &str,
        window_label: &str,
        url: &str,
        rect: PaneRect,
    ) -> Result<(), String> {
        let parsed: Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
        if !pane_url_allowed(&parsed, &self.host_origin) {
            return Err("url_not_allowed".to_string());
        }
        let window = self
            .app
            .get_window(window_label)
            .ok_or_else(|| "window_not_found".to_string())?;
        if self.panes.lock().unwrap().contains_key(pane_id) {
            return Err("pane_already_exists".to_string());
        }
        let host_origin = self.host_origin.clone();
        let builder = WebviewBuilder::new(
            format!("browser-pane-{pane_id}"),
            WebviewUrl::External(parsed),
        )
        .on_navigation(move |url| pane_url_allowed(url, &host_origin))
        .on_new_window(|_url, _features| NewWindowResponse::Deny);
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(rect.x, rect.y),
                LogicalSize::new(rect.width, rect.height),
            )
            .map_err(|e| format!("webview create failed: {e}"))?;
        // Start hidden: the WebView layer shows the pane once its tab is the
        // active preview and the panel is open.
        let _ = webview.hide();
        self.panes
            .lock()
            .unwrap()
            .insert(pane_id.to_string(), webview);
        Ok(())
    }

    pub fn set_rect(&self, pane_id: &str, rect: PaneRect) -> Result<(), String> {
        let panes = self.panes.lock().unwrap();
        let webview = panes
            .get(pane_id)
            .ok_or_else(|| "pane_not_found".to_string())?;
        webview
            .set_position(LogicalPosition::new(rect.x, rect.y))
            .map_err(|e| format!("set_position failed: {e}"))?;
        webview
            .set_size(LogicalSize::new(rect.width, rect.height))
            .map_err(|e| format!("set_size failed: {e}"))?;
        Ok(())
    }

    pub fn set_visible(&self, pane_id: &str, visible: bool) -> Result<(), String> {
        let panes = self.panes.lock().unwrap();
        let webview = panes
            .get(pane_id)
            .ok_or_else(|| "pane_not_found".to_string())?;
        if visible {
            webview.show().map_err(|e| format!("show failed: {e}"))?;
        } else {
            webview.hide().map_err(|e| format!("hide failed: {e}"))?;
        }
        Ok(())
    }

    pub fn navigate(&self, pane_id: &str, url: &str) -> Result<(), String> {
        let parsed: Url = url.parse().map_err(|e| format!("invalid URL: {e}"))?;
        if !pane_url_allowed(&parsed, &self.host_origin) {
            return Err("url_not_allowed".to_string());
        }
        let panes = self.panes.lock().unwrap();
        let webview = panes
            .get(pane_id)
            .ok_or_else(|| "pane_not_found".to_string())?;
        webview
            .navigate(parsed)
            .map_err(|e| format!("navigate failed: {e}"))
    }

    pub fn url(&self, pane_id: &str) -> Result<String, String> {
        let panes = self.panes.lock().unwrap();
        let webview = panes
            .get(pane_id)
            .ok_or_else(|| "pane_not_found".to_string())?;
        webview
            .url()
            .map(|u| u.to_string())
            .map_err(|e| format!("url failed: {e}"))
    }

    pub fn destroy(&self, pane_id: &str) -> Result<(), String> {
        let webview = self.panes.lock().unwrap().remove(pane_id);
        match webview {
            Some(webview) => webview.close().map_err(|e| format!("close failed: {e}")),
            None => Err("pane_not_found".to_string()),
        }
    }

    /// Drop every pane belonging to a window that was destroyed; stale map
    /// entries would otherwise leak webviews and collide on label reuse.
    pub fn destroy_all_for_window(&self, window_label: &str) {
        let mut panes = self.panes.lock().unwrap();
        let stale: Vec<String> = panes
            .iter()
            .filter(|(_, webview)| webview.window().label() == window_label)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(webview) = panes.remove(&id) {
                let _ = webview.close();
            }
        }
    }

    /// Evaluate an expression and return its JSON serialization. The wrapper
    /// catches exceptions because `eval_with_callback` ignores them on
    /// Windows; the timeout guards against a callback that never fires.
    pub async fn eval_json(&self, pane_id: &str, expression: &str) -> Result<String, String> {
        let wrapped = format!(
            "(function() {{ try {{ var v = ({expression}); return JSON.stringify({{ ok: true, value: v }}); }} catch (e) {{ return JSON.stringify({{ ok: false, error: String(e) }}); }} }})()"
        );
        let rx = {
            // Scope the pane lock: it must never live across the await below.
            let panes = self.panes.lock().unwrap();
            let webview = panes
                .get(pane_id)
                .ok_or_else(|| "pane_not_found".to_string())?;
            let (tx, rx) = tokio::sync::oneshot::channel::<String>();
            let tx = std::sync::Mutex::new(Some(tx));
            webview
                .eval_with_callback(&wrapped, move |json| {
                    if let Ok(mut slot) = tx.lock() {
                        if let Some(sender) = slot.take() {
                            let _ = sender.send(json);
                        }
                    }
                })
                .map_err(|e| format!("eval failed: {e}"))?;
            rx
        };
        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(json)) => Ok(json),
            _ => Err("eval_timeout".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn allows_http_https_except_host_origin() {
        let host = "http://127.0.0.1:41000";
        assert!(pane_url_allowed(&url("http://localhost:5173/"), host));
        assert!(pane_url_allowed(&url("https://example.com/page"), host));
        assert!(!pane_url_allowed(&url("http://127.0.0.1:41000/app"), host));
        // userinfo is not a host: this URL actually loads evil.com, which is
        // an ordinary external page, not a jump back to the host origin.
        assert!(pane_url_allowed(
            &url("http://127.0.0.1:41000@evil.com/"),
            host
        ));
    }

    #[test]
    fn denies_non_http_schemes() {
        let host = "http://127.0.0.1:41000";
        assert!(!pane_url_allowed(&url("file:///etc/passwd"), host));
        assert!(!pane_url_allowed(&url("tauri://localhost/x"), host));
        assert!(!pane_url_allowed(&url("about:blank"), host));
    }

    #[test]
    fn different_port_on_same_host_is_allowed() {
        let host = "http://127.0.0.1:41000";
        // officecli watch servers bind their own loopback ports
        assert!(pane_url_allowed(&url("http://127.0.0.1:41001/"), host));
    }
}
