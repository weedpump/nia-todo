!macro NSIS_HOOK_PREINSTALL
  ; Native app bundles the web UI locally. Preserve Rust app settings and
  ; WebView storage, but clear stale WebView2 cache/service-worker state before
  ; copying a new build. WebView2 stores this state below EBWebView on Windows.
  SetShellVarContext current
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Service Worker"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Cache"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Code Cache"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\EBWebView\GPUCache"
!macroend
