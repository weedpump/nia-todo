!macro NSIS_HOOK_PREINSTALL
  ; Native app bundles the web UI locally. Preserve Rust app settings and
  ; WebView storage, but clear stale WebView2 cache/service-worker state before
  ; copying a new build. WebView2 stores default-profile cache state below
  ; EBWebView\Default on Windows.
  SetShellVarContext current
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Service Worker"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Cache"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Code Cache"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\GPUCache"
!macroend
