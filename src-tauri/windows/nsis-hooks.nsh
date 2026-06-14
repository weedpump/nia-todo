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
  WriteRegStr HKCU "Software\Classes\nia-todo" "" "URL:nia-todo"
  WriteRegStr HKCU "Software\Classes\nia-todo" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\nia-todo\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\nia-todo\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\nia-todo"
!macroend
