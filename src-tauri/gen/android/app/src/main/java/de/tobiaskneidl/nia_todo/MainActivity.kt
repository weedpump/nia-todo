package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaRecorder
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import java.util.Locale
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : TauriActivity() {
  private val nativePrefsName = "nia_todo_native"
  private val lastWebViewCacheVersionKey = "last_webview_cache_version"
  private val pendingOidcCallbackKey = "pending_oidc_callback_url"
  private val locationReminderScheduleMutex = Mutex()
  private val lightSystemBarColor = Color.rgb(248, 250, 252)
  private val darkSystemBarColor = Color.rgb(15, 15, 35)
  private val maxNativeAudioDurationMs = 120_000
  private val maxNativeAudioBytes = 8 * 1024 * 1024
  private val maxAndroidUpdateBytes = 512L * 1024L * 1024L
  private val maxAndroidUpdateDurationMs = 9L * 60L * 1000L
  private val androidUpdateInFlight = AtomicBoolean(false)
  private val androidUpdateCancelled = AtomicBoolean(false)
  private val notificationIds = AtomicInteger(1000)
  private val nativeAttachmentDownloadGeneration = AtomicInteger(0)
  private val nativeAttachmentDownloadCommitLock = Any()
  private var appWebView: WebView? = null
  private var nativeAudioRecorder: MediaRecorder? = null
  private var nativeAudioFile: File? = null
  private var nativeAudioStartedAtMs: Long = 0
  @Volatile private var configuredPasskeyOrigin: String? = null
  @Volatile private var configuredServerOrigin: String? = null
  @Volatile private var activeAndroidUpdateRequestId: String? = null
  @Volatile private var activeAndroidUpdateConnection: HttpURLConnection? = null
  @Volatile private var pendingAndroidInstallerRequestId: String? = null
  @Volatile private var pendingAndroidInstallerVersionCode: Long = 0
  @Volatile private var pendingAndroidInstallerFile: File? = null
  @Volatile private var androidInstallerWasPaused = false
  @Volatile private var pendingOidcCallbackUrl: String? = null
  private val credentialManager by lazy { CredentialManager.create(this) }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Android 15+ enforces edge-to-edge for targetSdk 35+.
    // Keep it enabled for correct system-bar contrast and apply real Insets
    // to the native content root that hosts the Tauri WebView.
    enableEdgeToEdge()
    applySystemBarsTheme(false)
    ReminderReceiver.createNotificationChannel(this)
    ReminderReceiver.rescheduleStoredReminders(this)
    LocationReminderReceiver.rescheduleStoredLocationReminders(this)
    clearStaleWebViewCachesOnVersionChange()
    super.onCreate(savedInstanceState)
    applySystemBarInsetsToContentRoot()
    handleOidcIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleOidcIntent(intent)
  }

  override fun onDestroy() {
    cleanupNativeAudioRecording()
    super.onDestroy()
  }

  override fun onResume() {
    super.onResume()
    if (LocationReminderReceiver.consumeLocationPermissionSettingsRoundTrip(this)) {
      val granted = LocationReminderReceiver.locationPermissionState(this) == "granted"
      LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, !granted)
    }
    LocationReminderReceiver.rescheduleStoredLocationReminders(this)
    handleReturnedAndroidInstaller()
  }

  override fun onPause() {
    if (pendingAndroidInstallerRequestId != null) androidInstallerWasPaused = true
    LocationReminderReceiver.markLocationPermissionSettingsPaused(this)
    super.onPause()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == 7303) {
      val fineIndex = permissions.indexOf(Manifest.permission.ACCESS_FINE_LOCATION)
      val fineGranted = fineIndex >= 0 && grantResults.getOrNull(fineIndex) == PackageManager.PERMISSION_GRANTED
      if (fineGranted) {
        requestLocationPermission()
      } else {
        LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, true)
      }
      LocationReminderReceiver.rescheduleStoredLocationReminders(this)
      return
    }
    if (requestCode == 7304) {
      val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
      LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, !granted)
      LocationReminderReceiver.rescheduleStoredLocationReminders(this)
    }
  }

  private fun clearStaleWebViewCachesOnVersionChange() {
    val prefs = getSharedPreferences(nativePrefsName, MODE_PRIVATE)
    val packageUpdatedAt = try {
      @Suppress("DEPRECATION")
      packageManager.getPackageInfo(packageName, 0).lastUpdateTime
    } catch (_: Exception) {
      0L
    }
    val currentVersion = "${BuildConfig.VERSION_NAME}:$packageUpdatedAt"
    if (prefs.getString(lastWebViewCacheVersionKey, "") == currentVersion) return

    val defaultProfile = File(dataDir, "app_webview/Default")
    for (relativePath in listOf("Service Worker", "Cache", "Code Cache", "GPUCache")) {
      File(defaultProfile, relativePath).deleteRecursively()
    }

    prefs.edit().putString(lastWebViewCacheVersionKey, currentVersion).apply()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    // The web UI owns overflow indicators; leaving the native WebView bars enabled
    // renders a second thumb beside the dashboard's overlay scrollbar.
    webView.isVerticalScrollBarEnabled = false
    webView.isHorizontalScrollBarEnabled = false
    val nativeBridge = AndroidNativeBridge()
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidNative")
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidSystemBars")
    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      val trustedLocalOrigins = setOf(
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost",
        "https://localhost",
        "http://127.0.0.1",
        "https://127.0.0.1",
        "http://[::1]",
        "https://[::1]",
      )
      WebViewCompat.addWebMessageListener(
        webView,
        "NiaAndroidUpdater",
        trustedLocalOrigins,
      ) { _, message, sourceOrigin, isMainFrame, _ ->
        handleAndroidUpdaterMessage(message.data, sourceOrigin, isMainFrame)
      }
      WebViewCompat.addWebMessageListener(
        webView,
        "NiaAndroidLocationPermission",
        trustedLocalOrigins,
      ) { _, message, sourceOrigin, isMainFrame, _ ->
        handleAndroidLocationPermissionMessage(message.data, sourceOrigin, isMainFrame)
      }
    }
    webView.post {
      applySystemBarInsetsToContentRoot()
    }
  }


  private fun isOidcCallbackUri(uri: Uri?): Boolean {
    if (uri == null) return false
    return uri.scheme.equals("nia-todo", ignoreCase = true) && uri.host.equals("oidc", ignoreCase = true) && uri.path == "/callback"
  }

  private fun handleOidcIntent(intent: Intent?) {
    try {
      if (intent?.action != Intent.ACTION_VIEW) return
      val uri = intent.data ?: return
      if (!isOidcCallbackUri(uri)) return
      storeOidcCallbackForWebLayer(uri.toString())
    } catch (_: Exception) {
      // Deep-link entry must never crash the native shell. If anything unexpected
      // happens, leave normal app startup intact so the user can retry/login again.
    }
  }

  private fun storeOidcCallbackForWebLayer(url: String) {
    // Keep the callback pending natively until the web layer explicitly consumes it.
    // Persist as well because the callback trampoline activity may run before the
    // Tauri activity/web layer is alive.
    pendingOidcCallbackUrl = url
    getSharedPreferences(nativePrefsName, MODE_PRIVATE)
      .edit()
      .putString(pendingOidcCallbackKey, url)
      .apply()
  }

  private fun canonicalServerOrigin(origin: String): String {
    val uri = URI(origin.trim().trimEnd('/'))
    val scheme = (uri.scheme ?: throw IllegalArgumentException("Origin fehlt")).lowercase(Locale.ROOT)
    if (scheme != "https" && scheme != "http") throw IllegalArgumentException("Server-Origin muss HTTP(S) sein")
    val host = (uri.host ?: throw IllegalArgumentException("Origin-Host fehlt")).lowercase(Locale.ROOT)
    if (!uri.rawUserInfo.isNullOrBlank()) throw IllegalArgumentException("Origin darf keine Zugangsdaten enthalten")
    if (!uri.rawQuery.isNullOrBlank() || !uri.rawFragment.isNullOrBlank()) throw IllegalArgumentException("Origin darf keinen Query-String enthalten")
    val defaultPort = (scheme == "https" && (uri.port == -1 || uri.port == 443)) || (scheme == "http" && (uri.port == -1 || uri.port == 80))
    val hostPart = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
    return if (defaultPort) "$scheme://$hostPart" else "$scheme://$hostPart:${uri.port}"
  }

  private fun canonicalOrigin(origin: String): String {
    val canonical = canonicalServerOrigin(origin)
    val uri = URI(canonical)
    val scheme = uri.scheme.lowercase(Locale.ROOT)
    val host = uri.host.lowercase(Locale.ROOT)
    val localHttp = scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
    if (scheme != "https" && !localHttp) throw IllegalArgumentException("Passkeys benötigen HTTPS")
    return canonical
  }

  private fun originHost(origin: String): String {
    return (URI(canonicalOrigin(origin)).host ?: "").lowercase(Locale.ROOT)
  }

  private fun validatePasskeyRequest(origin: String, optionsJson: String, register: Boolean): String {
    if (!isTrustedPasskeyWebView()) {
      throw IllegalStateException("Passkey-Bridge ist nur im lokalen App-Shell-Kontext verfügbar")
    }
    val canonical = canonicalOrigin(origin)
    val configured = configuredPasskeyOrigin
      ?: throw IllegalStateException("Server-Origin für Passkeys ist nicht konfiguriert")
    if (canonical != configured) throw IllegalArgumentException("Passkey-Origin passt nicht zur konfigurierten Server-URL")
    val host = originHost(canonical)
    val options = JSONObject(optionsJson)
    val rpId = if (register) {
      options.optJSONObject("rp")?.optString("id", "") ?: ""
    } else {
      options.optString("rpId", "")
    }.trim().lowercase(Locale.ROOT)
    if (rpId.isBlank()) throw IllegalArgumentException("Passkey-RP-ID fehlt")
    if (rpId != host) throw IllegalArgumentException("Passkey-RP-ID passt nicht zur Server-Origin")
    return canonical
  }

  private fun isTrustedLocalWebViewUrl(url: String?): Boolean {
    if (url.isNullOrBlank()) return false
    return try {
      val uri = URI(url)
      val scheme = (uri.scheme ?: "").lowercase(Locale.ROOT)
      val host = (uri.host ?: "").lowercase(Locale.ROOT)
      val localShellHost = host == "tauri.localhost" || host == "localhost" || host == "127.0.0.1" || host == "::1"
      (scheme == "http" || scheme == "https") && localShellHost
    } catch (_: Exception) {
      false
    }
  }

  private fun isTrustedLocalWebView(): Boolean {
    val webView = appWebView ?: return false
    if (Looper.myLooper() == Looper.getMainLooper()) return isTrustedLocalWebViewUrl(webView.url)

    val result = AtomicBoolean(false)
    val latch = CountDownLatch(1)
    runOnUiThread {
      try {
        result.set(isTrustedLocalWebViewUrl(webView.url))
      } finally {
        latch.countDown()
      }
    }
    latch.await(250, TimeUnit.MILLISECONDS)
    return result.get()
  }

  private fun isTrustedPasskeyWebView(): Boolean {
    return isTrustedLocalWebView()
  }

  private fun performViewHapticFeedback(effect: Int): Boolean {
    val result = AtomicBoolean(false)
    val action = Runnable {
      val view = appWebView ?: window.decorView
      @Suppress("DEPRECATION")
      result.set(view.performHapticFeedback(effect, HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING))
    }

    if (Looper.myLooper() == Looper.getMainLooper()) {
      action.run()
      return result.get()
    }

    val latch = CountDownLatch(1)
    runOnUiThread {
      try {
        action.run()
      } finally {
        latch.countDown()
      }
    }
    latch.await(250, TimeUnit.MILLISECONDS)
    return result.get()
  }

  private fun shouldUseDirectHapticFallback(): Boolean {
    return Build.MANUFACTURER.equals("samsung", ignoreCase = true)
  }

  private fun vibrateHapticFallback(patternMs: Int): Boolean {
    return try {
      val durationMs = patternMs.coerceIn(8, 80).toLong()
      val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        getSystemService(VibratorManager::class.java).defaultVibrator
      } else {
        @Suppress("DEPRECATION")
        getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      }
      if (!vibrator.hasVibrator()) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
      } else {
        @Suppress("DEPRECATION")
        vibrator.vibrate(durationMs)
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun completePasskeyRequest(requestId: String, success: Boolean, payload: String) {
    val webView = appWebView ?: return
    val script = if (success) {
      try {
        JSONObject(payload)
        "window.__niaAndroidPasskeyComplete && window.__niaAndroidPasskeyComplete(${JSONObject.quote(requestId)}, true, ${JSONObject.quote(payload)});"
      } catch (error: Exception) {
        "window.__niaAndroidPasskeyComplete && window.__niaAndroidPasskeyComplete(${JSONObject.quote(requestId)}, false, ${JSONObject.quote("Ungültige Passkey-Antwort")});"
      }
    } else {
      "window.__niaAndroidPasskeyComplete && window.__niaAndroidPasskeyComplete(${JSONObject.quote(requestId)}, false, ${JSONObject.quote(payload)});"
    }
    runOnUiThread { webView.evaluateJavascript(script, null) }
  }

  private fun applySystemBarInsetsToContentRoot() {
    val contentRoot = findViewById<ViewGroup>(android.R.id.content) ?: return

    ViewCompat.setOnApplyWindowInsetsListener(contentRoot) { view, windowInsets ->
      val systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
      windowInsets
    }

    ViewCompat.requestApplyInsets(contentRoot)
  }

  private fun applySystemBarsTheme(isDark: Boolean) {
    val color = if (isDark) darkSystemBarColor else lightSystemBarColor
    window.decorView.setBackgroundColor(color)
    @Suppress("DEPRECATION")
    window.statusBarColor = color
    @Suppress("DEPRECATION")
    window.navigationBarColor = color

    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = !isDark
    controller.isAppearanceLightNavigationBars = !isDark
  }

  private fun notificationPermissionState(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted"
    return if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      "granted"
    } else {
      "prompt"
    }
  }

  private fun requestNotificationPermission(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted"
    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return "granted"
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
    return "prompt"
  }

  private fun requestLocationPermission(): String {
    if (!LocationReminderReceiver.hasStoredLocationSchedules(this)) return LocationReminderReceiver.locationPermissionState(this)
    LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, false)
    val state = LocationReminderReceiver.locationPermissionState(this)
    if (state == "granted") return state
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION), 7303)
      return "prompt"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.parse("package:$packageName")
        }
        LocationReminderReceiver.beginLocationPermissionSettingsRoundTrip(this)
        startActivity(intent)
        return "background_settings"
      }
      requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 7304)
      return "foreground_only"
    }
    LocationReminderReceiver.rescheduleStoredLocationReminders(this)
    return LocationReminderReceiver.locationPermissionState(this)
  }

  private fun locationPermissionGuidanceState(): String {
    val state = LocationReminderReceiver.locationPermissionState(this)
    if (state == "granted") {
      LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, false)
      return state
    }
    return if (LocationReminderReceiver.isLocationPermissionGuidanceDeclined(this)) "declined" else state
  }

  private fun declineLocationPermissionGuidance(): Boolean {
    LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, true)
    return true
  }

  private fun resetLocationPermissionGuidance(): Boolean {
    LocationReminderReceiver.setLocationPermissionGuidanceDeclined(this, false)
    return true
  }

  private fun backgroundLocationPermissionOptionLabel(): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return ""
    return packageManager.backgroundPermissionOptionLabel.toString()
  }

  private fun backgroundLocationPermissionMode(): String {
    return when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> "settings"
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> "runtime_prompt"
      else -> "legacy"
    }
  }

  @Synchronized
  private fun cleanupNativeAudioRecording(deleteFile: Boolean = true) {
    val recorder = nativeAudioRecorder
    val file = nativeAudioFile
    nativeAudioRecorder = null
    nativeAudioFile = null
    nativeAudioStartedAtMs = 0
    try { recorder?.release() } catch (_: Exception) {}
    if (deleteFile) file?.delete()
  }

  @Synchronized
  private fun startNativeAudioRecording(): String {
    return try {
      if (!isTrustedLocalWebView()) return JSONObject().put("ok", false).put("error", "Native Aufnahme nur im lokalen App-Kontext verfügbar").toString()
      if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 7302)
        return JSONObject().put("ok", false).put("error", "Mikrofonberechtigung fehlt").toString()
      }
      cleanupNativeAudioRecording()
      val file = File.createTempFile("braindump-native-", ".m4a", cacheDir)
      val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioEncodingBitRate(96_000)
      recorder.setAudioSamplingRate(44_100)
      recorder.setMaxDuration(maxNativeAudioDurationMs)
      recorder.setOutputFile(file.absolutePath)
      recorder.prepare()
      recorder.start()
      nativeAudioRecorder = recorder
      nativeAudioFile = file
      nativeAudioStartedAtMs = SystemClock.elapsedRealtime()
      JSONObject()
        .put("ok", true)
        .put("mime", "audio/mp4")
        .put("maxDurationMs", maxNativeAudioDurationMs)
        .put("maxBytes", maxNativeAudioBytes)
        .toString()
    } catch (error: Exception) {
      cleanupNativeAudioRecording()
      JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
  }

  @Synchronized
  private fun nativeAudioAmplitude(): Int {
    if (!isTrustedLocalWebView()) return 0
    return try {
      nativeAudioRecorder?.maxAmplitude ?: 0
    } catch (_: Exception) {
      0
    }
  }

  @Synchronized
  private fun stopNativeAudioRecording(): String {
    if (!isTrustedLocalWebView()) return JSONObject().put("ok", false).put("error", "Native Aufnahme nur im lokalen App-Kontext verfügbar").toString()
    val recorder = nativeAudioRecorder
    val file = nativeAudioFile
    nativeAudioRecorder = null
    nativeAudioFile = null
    val startedAtMs = nativeAudioStartedAtMs
    nativeAudioStartedAtMs = 0
    if (recorder == null || file == null) return JSONObject().put("ok", false).put("error", "Keine aktive native Aufnahme").toString()
    return try {
      try { recorder.stop() } catch (_: Exception) {}
      recorder.release()
      val elapsedMs = if (startedAtMs > 0) SystemClock.elapsedRealtime() - startedAtMs else 0
      val size = file.length()
      if (size > maxNativeAudioBytes) {
        file.delete()
        return JSONObject().put("ok", false).put("error", "Aufnahme ist zu lang").put("size", size).put("maxBytes", maxNativeAudioBytes).toString()
      }
      val bytes = file.readBytes()
      file.delete()
      JSONObject()
        .put("ok", true)
        .put("mime", "audio/mp4")
        .put("durationMs", elapsedMs)
        .put("size", bytes.size)
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .toString()
    } catch (error: Exception) {
      try { recorder.release() } catch (_: Exception) {}
      file.delete()
      JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
  }

  private fun showNativeNotification(title: String, body: String): Boolean {
    if (notificationPermissionState() != "granted") return false
    ReminderReceiver.createNotificationChannel(this)

    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val largeIcon = BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher)
    val notification = NotificationCompat.Builder(this, ReminderReceiver.CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_notification)
      .setLargeIcon(largeIcon)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)
      .build()

    NotificationManagerCompat.from(this).notify(notificationIds.incrementAndGet(), notification)
    return true
  }

  private fun emitAndroidUpdateProgress(requestId: String, phase: String, downloadedBytes: Long, totalBytes: Long) {
    val payload = JSONObject()
      .put("phase", phase)
      .put("downloadedBytes", downloadedBytes)
      .put("totalBytes", totalBytes)
      .toString()
    runOnUiThread {
      appWebView?.evaluateJavascript(
        "window.__niaAndroidUpdateProgress?.(${JSONObject.quote(requestId)}, $payload);",
        null,
      )
    }
  }

  private fun completeAndroidUpdate(requestId: String, success: Boolean, payload: JSONObject) {
    runOnUiThread {
      appWebView?.evaluateJavascript(
        "window.__niaAndroidUpdateComplete?.(${JSONObject.quote(requestId)}, $success, ${payload});",
        null,
      )
    }
  }

  private fun respondAndroidUpdaterCall(requestId: String, success: Boolean, payload: JSONObject) {
    runOnUiThread {
      appWebView?.evaluateJavascript(
        "window.__niaAndroidUpdaterResponse?.(${JSONObject.quote(requestId)}, $success, ${payload});",
        null,
      )
    }
  }

  private fun respondAndroidLocationPermissionCall(requestId: String, success: Boolean, payload: JSONObject) {
    runOnUiThread {
      appWebView?.evaluateJavascript(
        "window.__niaAndroidLocationPermissionResponse?.(${JSONObject.quote(requestId)}, $success, ${payload});",
        null,
      )
    }
  }

  private fun isTrustedAndroidUpdaterSource(sourceOrigin: Uri, isMainFrame: Boolean): Boolean {
    if (!isMainFrame) return false
    return isTrustedLocalWebViewUrl(sourceOrigin.toString())
  }

  private fun handleAndroidUpdaterMessage(raw: String?, sourceOrigin: Uri, isMainFrame: Boolean) {
    val message = try { JSONObject(raw ?: "") } catch (_: Exception) { return }
    val requestId = message.optString("requestId", "")
    if (requestId.isBlank()) return
    if (!isTrustedAndroidUpdaterSource(sourceOrigin, isMainFrame)) {
      respondAndroidUpdaterCall(requestId, false, JSONObject().put("error", "Android updater bridge is unavailable from this frame"))
      return
    }
    when (message.optString("action", "")) {
      "permissionState" -> respondAndroidUpdaterCall(
        requestId,
        true,
        JSONObject().put("state", updateInstallPermissionState()),
      )
      "openPermissionSettings" -> respondAndroidUpdaterCall(
        requestId,
        true,
        JSONObject().put("opened", openUpdateInstallPermissionSettings()),
      )
      "install" -> startAndroidUpdate(
        requestId = requestId,
        url = message.optString("url", ""),
        filename = message.optString("filename", ""),
        expectedSha256 = message.optString("expectedSha256", ""),
        expectedSize = message.optLong("expectedSize", 0),
        expectedVersion = message.optString("expectedVersion", ""),
      )
      "cancel" -> cancelAndroidUpdate(requestId)
      else -> respondAndroidUpdaterCall(requestId, false, JSONObject().put("error", "Unknown Android updater action"))
    }
  }

  private fun handleAndroidLocationPermissionMessage(raw: String?, sourceOrigin: Uri, isMainFrame: Boolean) {
    val message = try { JSONObject(raw ?: "") } catch (_: Exception) { return }
    val requestId = message.optString("requestId", "")
    if (requestId.isBlank()) return
    if (!isTrustedAndroidUpdaterSource(sourceOrigin, isMainFrame)) {
      respondAndroidLocationPermissionCall(requestId, false, JSONObject().put("error", "Android location permission bridge is unavailable from this frame"))
      return
    }
    val action = message.optString("action", "")
    if (action == "schedule") {
      val schedulesJson = message.optJSONArray("schedules")?.toString() ?: "[]"
      lifecycleScope.launch(Dispatchers.IO) {
        try {
          val count = locationReminderScheduleMutex.withLock {
            LocationReminderReceiver.scheduleLocationReminders(this@MainActivity, schedulesJson)
          }
          respondAndroidLocationPermissionCall(requestId, true, JSONObject().put("count", count))
        } catch (_: Exception) {
          respondAndroidLocationPermissionCall(
            requestId,
            false,
            JSONObject().put("error", "Android location reminder scheduling failed"),
          )
        }
      }
      return
    }
    val payload = when (action) {
      "state" -> JSONObject().put("state", LocationReminderReceiver.locationPermissionState(this))
      "guidanceState" -> JSONObject().put("state", locationPermissionGuidanceState())
      "decline" -> JSONObject().put("declined", declineLocationPermissionGuidance())
      "resetGuidance" -> JSONObject().put("reset", resetLocationPermissionGuidance())
      "optionLabel" -> JSONObject().put("label", backgroundLocationPermissionOptionLabel())
      "mode" -> JSONObject().put("mode", backgroundLocationPermissionMode())
      "request" -> JSONObject().put("state", requestLocationPermission())
      else -> {
        respondAndroidLocationPermissionCall(requestId, false, JSONObject().put("error", "Unknown Android location permission action"))
        return
      }
    }
    respondAndroidLocationPermissionCall(requestId, true, payload)
  }

  private fun cancelAndroidUpdate(requestId: String) {
    if (activeAndroidUpdateRequestId != requestId) return
    androidUpdateCancelled.set(true)
    activeAndroidUpdateConnection?.disconnect()
  }

  private fun updateInstallPermissionState(): String {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (packageManager.canRequestPackageInstalls()) "granted" else "prompt"
    } else {
      val allowed = Settings.Secure.getInt(contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, 0) == 1
      if (allowed) "granted" else "prompt"
    }
  }

  private fun openUpdateInstallPermissionSettings(): Boolean {
    return try {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
      } else {
        Intent(Settings.ACTION_SECURITY_SETTINGS)
      }
      startActivity(intent)
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun signatureDigests(info: android.content.pm.PackageInfo): Set<String> {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.apkContentsSigners?.toList().orEmpty()
    } else {
      @Suppress("DEPRECATION")
      info.signatures?.toList().orEmpty()
    }
    return signatures.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }.toSet()
  }

  private fun verifyAndroidUpdatePackage(apk: File, expectedVersion: String): Long {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      @Suppress("DEPRECATION")
      PackageManager.GET_SIGNATURES
    }
    val archive = packageManager.getPackageArchiveInfo(apk.absolutePath, flags)
      ?: throw IllegalArgumentException("Downloaded file is not a valid Android package")
    val installed = packageManager.getPackageInfo(packageName, flags)
    if (archive.packageName != packageName) throw IllegalArgumentException("Android update package name does not match")
    if (archive.versionName != expectedVersion) throw IllegalArgumentException("Android update version does not match")
    val archiveVersionCode = PackageInfoCompat.getLongVersionCode(archive)
    if (archiveVersionCode <= PackageInfoCompat.getLongVersionCode(installed)) {
      throw IllegalArgumentException("Android update must have a higher version code")
    }
    val installedSigners = signatureDigests(installed)
    val updateSigners = signatureDigests(archive)
    if (installedSigners.isEmpty() || updateSigners != installedSigners) {
      throw IllegalArgumentException("Android update signing certificate does not match")
    }
    return archiveVersionCode
  }

  private fun handleReturnedAndroidInstaller() {
    val requestId = pendingAndroidInstallerRequestId ?: return
    if (!androidInstallerWasPaused) return
    val expectedVersionCode = pendingAndroidInstallerVersionCode
    val stagedApk = pendingAndroidInstallerFile
    pendingAndroidInstallerRequestId = null
    pendingAndroidInstallerVersionCode = 0
    pendingAndroidInstallerFile = null
    androidInstallerWasPaused = false
    lifecycleScope.launch(Dispatchers.IO) {
      val installedVersionCode = try {
        PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0))
      } catch (_: Exception) {
        0L
      }
      stagedApk?.delete()
      androidUpdateInFlight.set(false)
      if (installedVersionCode >= expectedVersionCode && expectedVersionCode > 0) {
        completeAndroidUpdate(requestId, true, JSONObject().put("started", true))
      } else {
        completeAndroidUpdate(requestId, false, JSONObject().put("error", "Android update installation was cancelled or failed"))
      }
    }
  }

  private fun startAndroidUpdate(
    requestId: String,
    url: String,
    filename: String,
    expectedSha256: String,
    expectedSize: Long,
    expectedVersion: String,
  ) {
    if (!androidUpdateInFlight.compareAndSet(false, true)) {
      completeAndroidUpdate(requestId, false, JSONObject().put("error", "Another Android update is already running"))
      return
    }
    androidUpdateCancelled.set(false)
    activeAndroidUpdateRequestId = requestId
    lifecycleScope.launch(Dispatchers.IO) {
      var stagedApk: File? = null
      var installerLaunched = false
      try {
        if (updateInstallPermissionState() != "granted") throw IllegalStateException("Android install permission is not granted")
        val normalizedVersion = expectedVersion.removePrefix("v")
        if (!Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$").matches(normalizedVersion)) {
          throw IllegalArgumentException("Invalid Android update version")
        }
        if (filename != "nia-todo-v${normalizedVersion}-android-arm64.apk") {
          throw IllegalArgumentException("Invalid Android update filename")
        }
        if (!Regex("^[0-9a-fA-F]{64}$").matches(expectedSha256)) {
          throw IllegalArgumentException("Invalid Android update SHA-256")
        }
        if (expectedSize <= 0 || expectedSize > maxAndroidUpdateBytes) {
          throw IllegalArgumentException("Invalid Android update size")
        }
        val uri = URI(url)
        val scheme = (uri.scheme ?: "").lowercase(Locale.ROOT)
        if (scheme != "https" && scheme != "http") throw IllegalArgumentException("Unsupported Android update URL")
        if (uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) {
          throw IllegalArgumentException("Invalid Android update URL")
        }
        if (uri.rawPath != "/downloads/$filename") throw IllegalArgumentException("Invalid Android update URL path")
        val configured = configuredServerOrigin
          ?: throw IllegalStateException("Server origin is not configured")
        val requestedOrigin = "${scheme}://${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}"
        if (canonicalServerOrigin(requestedOrigin) != configured) {
          throw IllegalArgumentException("Android update URL does not match configured server")
        }

        val updateDir = File(cacheDir, "native-updates").apply { mkdirs() }
        val target = File(updateDir, filename)
        if (target.parentFile?.canonicalFile != updateDir.canonicalFile) {
          throw IllegalArgumentException("Invalid Android update path")
        }
        stagedApk = target
        if (target.exists() && !target.delete()) throw IllegalStateException("Could not replace staged Android update")

        val digest = MessageDigest.getInstance("SHA-256")
        var downloaded = 0L
        val downloadStartedAt = SystemClock.elapsedRealtime()
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
          requestMethod = "GET"
          connectTimeout = 15_000
          readTimeout = 15_000
          instanceFollowRedirects = false
          useCaches = false
        }
        activeAndroidUpdateConnection = connection
        try {
          connection.connect()
          if (connection.responseCode != HttpURLConnection.HTTP_OK) {
            throw IllegalStateException("Android update download failed: HTTP ${connection.responseCode}")
          }
          val contentLength = connection.contentLengthLong
          if (contentLength > maxAndroidUpdateBytes || (contentLength >= 0 && contentLength != expectedSize)) {
            throw IllegalStateException("Android update download size does not match")
          }
          emitAndroidUpdateProgress(requestId, "downloading", 0, expectedSize)
          connection.inputStream.use { input ->
            FileOutputStream(target).use { output ->
              val buffer = ByteArray(64 * 1024)
              while (true) {
                if (androidUpdateCancelled.get()) throw IllegalStateException("Android update was cancelled")
                if (SystemClock.elapsedRealtime() - downloadStartedAt > maxAndroidUpdateDurationMs) {
                  throw IllegalStateException("Android update download timed out")
                }
                val count = input.read(buffer)
                if (count < 0) break
                downloaded += count
                if (downloaded > expectedSize || downloaded > maxAndroidUpdateBytes) {
                  throw IllegalStateException("Android update exceeds expected size")
                }
                digest.update(buffer, 0, count)
                output.write(buffer, 0, count)
                emitAndroidUpdateProgress(requestId, "downloading", downloaded, expectedSize)
              }
              output.fd.sync()
            }
          }
        } finally {
          activeAndroidUpdateConnection = null
          connection.disconnect()
        }
        if (androidUpdateCancelled.get()) throw IllegalStateException("Android update was cancelled")
        if (downloaded != expectedSize) throw IllegalStateException("Android update download is incomplete")
        val actualSha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (!actualSha256.equals(expectedSha256, ignoreCase = true)) {
          throw IllegalStateException("Android update SHA-256 does not match")
        }
        val targetVersionCode = verifyAndroidUpdatePackage(target, normalizedVersion)
        emitAndroidUpdateProgress(requestId, "installing", expectedSize, expectedSize)
        val contentUri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", target)
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(contentUri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        pendingAndroidInstallerRequestId = requestId
        pendingAndroidInstallerVersionCode = targetVersionCode
        pendingAndroidInstallerFile = target
        androidInstallerWasPaused = false
        withContext(Dispatchers.Main) { startActivity(installIntent) }
        installerLaunched = true
      } catch (error: Exception) {
        pendingAndroidInstallerRequestId = null
        pendingAndroidInstallerVersionCode = 0
        pendingAndroidInstallerFile = null
        androidInstallerWasPaused = false
        stagedApk?.delete()
        completeAndroidUpdate(requestId, false, JSONObject().put("error", error.message ?: error.javaClass.simpleName))
      } finally {
        activeAndroidUpdateRequestId = null
        activeAndroidUpdateConnection = null
        androidUpdateCancelled.set(false)
        if (!installerLaunched) androidUpdateInFlight.set(false)
      }
    }
  }

  private fun safeDownloadFilename(raw: String): String {
    val fallback = "attachment"
    val cleaned = raw
      .trim()
      .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]+"), "_")
      .trim(' ', '.', '_')
      .take(180)
    return cleaned.ifBlank { fallback }
  }

  private fun startNativeDownloadToDownloads(url: String, filename: String, headersJson: String): String {
    return try {
      val downloadGeneration = nativeAttachmentDownloadGeneration.get()
      val uri = URI(url)
      val scheme = (uri.scheme ?: "").lowercase(Locale.ROOT)
      if (scheme != "https" && scheme != "http") throw IllegalArgumentException("Unsupported download URL")
      val configured = configuredServerOrigin
      val requestedOrigin = "${scheme}://${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}"
      if (configured != null && canonicalServerOrigin(requestedOrigin) != configured) {
        throw IllegalArgumentException("Download URL does not match configured server")
      }
      val targetName = safeDownloadFilename(filename)
      val headers = JSONObject(headersJson.ifBlank { "{}" })
      lifecycleScope.launch(Dispatchers.IO) {
        var collectionUri: Uri? = null
        var legacyPendingFile: File? = null
        try {
          val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 60_000
            instanceFollowRedirects = false
            for (key in headers.keys()) {
              val value = headers.optString(key, "")
              if (key.isNotBlank() && value.isNotBlank()) setRequestProperty(key, value)
            }
          }
          connection.connect()
          val status = connection.responseCode
          if (status !in 200..299) throw IllegalStateException("Download failed: HTTP $status")
          if (downloadGeneration != nativeAttachmentDownloadGeneration.get()) throw IllegalStateException("Download cancelled for privacy transition")
          val mimeType = connection.contentType?.split(";", limit = 2)?.firstOrNull()?.trim()?.ifBlank { null }
            ?: "application/octet-stream"
          val savedLocation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
              put(MediaStore.Downloads.DISPLAY_NAME, targetName)
              put(MediaStore.Downloads.MIME_TYPE, mimeType)
              put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/nia-todo")
              put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val destinationUri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
              ?: throw IllegalStateException("Could not create download entry")
            collectionUri = destinationUri
            contentResolver.openOutputStream(destinationUri)?.use { output ->
              connection.inputStream.use { input -> input.copyTo(output) }
            } ?: throw IllegalStateException("Could not open download entry")
            synchronized(nativeAttachmentDownloadCommitLock) {
              if (downloadGeneration != nativeAttachmentDownloadGeneration.get()) throw IllegalStateException("Download cancelled for privacy transition")
              val done = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
              contentResolver.update(destinationUri, done, null, null)
            }
            "Downloads/nia-todo/$targetName"
          } else {
            val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "nia-todo").apply { mkdirs() }
            val target = File(dir, targetName)
            val pending = File(dir, ".$targetName.$downloadGeneration.part")
            legacyPendingFile = pending
            pending.outputStream().use { output ->
              connection.inputStream.use { input -> input.copyTo(output) }
            }
            synchronized(nativeAttachmentDownloadCommitLock) {
              if (downloadGeneration != nativeAttachmentDownloadGeneration.get()) throw IllegalStateException("Download cancelled for privacy transition")
              if (target.exists() && !target.delete()) throw IllegalStateException("Could not replace existing download")
              if (!pending.renameTo(target)) throw IllegalStateException("Could not publish download")
              legacyPendingFile = null
            }
            target.absolutePath
          }
          runOnUiThread {
            Toast.makeText(this@MainActivity, "Gespeichert: $savedLocation", Toast.LENGTH_LONG).show()
          }
        } catch (error: Exception) {
          collectionUri?.let { runCatching { contentResolver.delete(it, null, null) } }
          legacyPendingFile?.let { runCatching { it.delete() } }
          runOnUiThread {
            Toast.makeText(this@MainActivity, "Download fehlgeschlagen: ${error.message ?: error.javaClass.simpleName}", Toast.LENGTH_LONG).show()
          }
        }
      }
      JSONObject().put("ok", true).put("filename", targetName).toString()
    } catch (error: Exception) {
      JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
  }

  private fun cancelAttachmentDownloadsForPrivacy(): Boolean {
    synchronized(nativeAttachmentDownloadCommitLock) {
      nativeAttachmentDownloadGeneration.incrementAndGet()
    }
    return true
  }

  inner class AndroidNativeBridge {
    @JavascriptInterface
    fun setTheme(theme: String) {
      runOnUiThread {
        applySystemBarsTheme(theme == "dark")
      }
    }

    @JavascriptInterface
    fun appVersion(): String {
      return BuildConfig.VERSION_NAME
    }

    @JavascriptInterface
    fun openExternal(url: String): Boolean {
      return try {
        if (url.any { it.isISOControl() }) return false
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
        if (scheme != "http" && scheme != "https") return false
        if (uri.host.isNullOrBlank()) return false

        val intent = Intent(Intent.ACTION_VIEW, uri)
        startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun downloadToDownloads(url: String, filename: String, headersJson: String): String {
      return this@MainActivity.startNativeDownloadToDownloads(url, filename, headersJson)
    }

    @JavascriptInterface
    fun cancelAttachmentDownloadsForPrivacy(): Boolean {
      return this@MainActivity.cancelAttachmentDownloadsForPrivacy()
    }

    @JavascriptInterface
    fun consumePendingOidcCallback(): String {
      val prefs = getSharedPreferences(nativePrefsName, MODE_PRIVATE)
      val pending = pendingOidcCallbackUrl ?: prefs.getString(pendingOidcCallbackKey, "") ?: ""
      pendingOidcCallbackUrl = null
      if (pending.isNotBlank()) prefs.edit().remove(pendingOidcCallbackKey).apply()
      return pending
    }

    @JavascriptInterface
    fun requestNotificationPermission(): String {
      return this@MainActivity.requestNotificationPermission()
    }

    @JavascriptInterface
    fun notificationPermissionState(): String {
      return this@MainActivity.notificationPermissionState()
    }

    @JavascriptInterface
    fun notify(title: String, body: String): Boolean {
      return this@MainActivity.showNativeNotification(title, body)
    }

    @JavascriptInterface
    fun startAudioRecording(): String {
      return this@MainActivity.startNativeAudioRecording()
    }

    @JavascriptInterface
    fun stopAudioRecording(): String {
      return this@MainActivity.stopNativeAudioRecording()
    }

    @JavascriptInterface
    fun audioAmplitude(): Int {
      return this@MainActivity.nativeAudioAmplitude()
    }

    @JavascriptInterface
    fun scheduleReminders(schedulesJson: String): Int {
      return ReminderReceiver.scheduleReminders(this@MainActivity, schedulesJson)
    }

    @JavascriptInterface
    fun hapticFeedback(patternMs: Int): Boolean {
      val effect = if (patternMs >= 18) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      if (shouldUseDirectHapticFallback()) return vibrateHapticFallback(patternMs)
      if (performViewHapticFeedback(effect)) return true
      return vibrateHapticFallback(patternMs)
    }

    @JavascriptInterface
    fun setConfiguredServerUrl(serverUrl: String): Boolean {
      return try {
        val serverOrigin = canonicalServerOrigin(serverUrl)
        configuredServerOrigin = serverOrigin
        configuredPasskeyOrigin = runCatching { canonicalOrigin(serverOrigin) }.getOrNull()
        true
      } catch (_: Exception) {
        configuredServerOrigin = null
        configuredPasskeyOrigin = null
        false
      }
    }

    @JavascriptInterface
    fun supportsPasskeys(): Boolean {
      return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
    }

    @JavascriptInterface
    fun passkeyRegister(requestId: String, origin: String, optionsJson: String) {
      lifecycleScope.launch {
        try {
          validatePasskeyRequest(origin, optionsJson, register = true)
          val request = CreatePublicKeyCredentialRequest(
            requestJson = optionsJson,
            preferImmediatelyAvailableCredentials = false,
          )
          val response = credentialManager.createCredential(
            context = this@MainActivity,
            request = request,
          ) as CreatePublicKeyCredentialResponse
          completePasskeyRequest(requestId, true, response.registrationResponseJson)
        } catch (error: Exception) {
          completePasskeyRequest(requestId, false, error.message ?: error.javaClass.simpleName)
        }
      }
    }

    @JavascriptInterface
    fun passkeyAuthenticate(requestId: String, origin: String, optionsJson: String) {
      lifecycleScope.launch {
        try {
          validatePasskeyRequest(origin, optionsJson, register = false)
          val option = GetPublicKeyCredentialOption(requestJson = optionsJson)
          val request = GetCredentialRequest.Builder()
            .addCredentialOption(option)
            .build()
          val response = credentialManager.getCredential(
            context = this@MainActivity,
            request = request,
          )
          val credential = response.credential as? PublicKeyCredential
            ?: throw IllegalStateException("Keine Passkey-Antwort erhalten")
          completePasskeyRequest(requestId, true, credential.authenticationResponseJson)
        } catch (error: Exception) {
          completePasskeyRequest(requestId, false, error.message ?: error.javaClass.simpleName)
        }
      }
    }
  }
}
