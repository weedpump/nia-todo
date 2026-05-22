!macro NSIS_HOOK_PREINSTALL
  ; Native app bundles the web UI locally. Preserve app settings and offline DB,
  ; but clear stale WebView2 cache/service-worker state before copying a new build.
  SetShellVarContext current
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\Service Worker"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\Cache"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\Code Cache"
  RmDir /r "$LOCALAPPDATA\${BUNDLEID}\GPUCache"
!macroend
