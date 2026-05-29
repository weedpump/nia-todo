package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import java.util.Locale
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : TauriActivity() {
  private val nativePrefsName = "nia_todo_native"
  private val lastWebViewCacheVersionKey = "last_webview_cache_version"
  private val lightSystemBarColor = Color.rgb(248, 250, 252)
  private val darkSystemBarColor = Color.rgb(15, 15, 35)
  private val notificationIds = AtomicInteger(1000)
  private var appWebView: WebView? = null
  @Volatile private var configuredPasskeyOrigin: String? = null
  private val credentialManager by lazy { CredentialManager.create(this) }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Android 15+ enforces edge-to-edge for targetSdk 35+.
    // Keep it enabled for correct system-bar contrast and apply real Insets
    // to the native content root that hosts the Tauri WebView.
    enableEdgeToEdge()
    applySystemBarsTheme(false)
    ReminderReceiver.createNotificationChannel(this)
    ReminderReceiver.rescheduleStoredReminders(this)
    clearStaleWebViewCachesOnVersionChange()
    persistDoneActionFromIntent(intent)
    super.onCreate(savedInstanceState)
    applySystemBarInsetsToContentRoot()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    persistDoneActionFromIntent(intent)
  }

  private fun clearStaleWebViewCachesOnVersionChange() {
    val prefs = getSharedPreferences(nativePrefsName, MODE_PRIVATE)
    val currentVersion = BuildConfig.VERSION_NAME
    if (prefs.getString(lastWebViewCacheVersionKey, "") == currentVersion) return

    val defaultProfile = File(dataDir, "app_webview/Default")
    for (relativePath in listOf("Service Worker", "Cache", "Code Cache", "GPUCache")) {
      File(defaultProfile, relativePath).deleteRecursively()
    }

    prefs.edit().putString(lastWebViewCacheVersionKey, currentVersion).apply()
  }

  private fun persistDoneActionFromIntent(intent: Intent?): String? {
    if (intent?.action != ReminderReceiver.ACTION_MARK_DONE) return null
    val id = intent.getStringExtra(ReminderReceiver.EXTRA_ID) ?: return null
    getSharedPreferences(ReminderReceiver.PREFS_NAME, MODE_PRIVATE)
      .edit()
      .putString(ReminderReceiver.PREFS_PENDING_DONE_ID, id)
      .putString(ReminderReceiver.PREFS_PENDING_DONE_ACTION, JSONObject().apply {
        put("id", id)
        put("userId", intent.getStringExtra(ReminderReceiver.EXTRA_USER_ID) ?: "")
        put("createdAtMs", System.currentTimeMillis())
      }.toString())
      .apply()
    NotificationManagerCompat.from(this).cancel(id.hashCode().let { if (it == Int.MIN_VALUE) 0 else kotlin.math.abs(it) })
    return id
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    val nativeBridge = AndroidNativeBridge()
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidNative")
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidSystemBars")
    webView.post { applySystemBarInsetsToContentRoot() }
  }

  private fun canonicalOrigin(origin: String): String {
    val uri = URI(origin.trim().trimEnd('/'))
    val scheme = (uri.scheme ?: throw IllegalArgumentException("Origin fehlt")).lowercase(Locale.ROOT)
    if (scheme != "https" && scheme != "http") throw IllegalArgumentException("Passkey-Origin muss HTTP(S) sein")
    val host = (uri.host ?: throw IllegalArgumentException("Origin-Host fehlt")).lowercase(Locale.ROOT)
    val localHttp = scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
    if (scheme != "https" && !localHttp) throw IllegalArgumentException("Passkeys benötigen HTTPS")
    if (!uri.rawUserInfo.isNullOrBlank()) throw IllegalArgumentException("Origin darf keine Zugangsdaten enthalten")
    if (!uri.rawQuery.isNullOrBlank() || !uri.rawFragment.isNullOrBlank()) throw IllegalArgumentException("Origin darf keinen Query-String enthalten")
    val defaultPort = (scheme == "https" && (uri.port == -1 || uri.port == 443)) || (scheme == "http" && (uri.port == -1 || uri.port == 80))
    val hostPart = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
    return if (defaultPort) "$scheme://$hostPart" else "$scheme://$hostPart:${uri.port}"
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

  private fun isTrustedPasskeyWebView(): Boolean {
    val url = appWebView?.url ?: return false
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

        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
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
    fun scheduleReminders(schedulesJson: String): Int {
      return ReminderReceiver.scheduleReminders(this@MainActivity, schedulesJson)
    }

    @JavascriptInterface
    fun hapticFeedback(patternMs: Int): Boolean {
      val effect = if (patternMs >= 18) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      runOnUiThread {
        val view = appWebView ?: window.decorView
        view.performHapticFeedback(effect)
      }
      return true
    }

    @JavascriptInterface
    fun setConfiguredServerUrl(serverUrl: String): Boolean {
      return try {
        val canonical = canonicalOrigin(serverUrl)
        if (configuredPasskeyOrigin == null) configuredPasskeyOrigin = canonical
        configuredPasskeyOrigin == canonical
      } catch (_: Exception) {
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

    @JavascriptInterface
    fun consumePendingDoneAction(): String {
      val prefs = getSharedPreferences(ReminderReceiver.PREFS_NAME, MODE_PRIVATE)
      val action = prefs.getString(ReminderReceiver.PREFS_PENDING_DONE_ACTION, "") ?: ""
      if (action.isNotBlank()) {
        prefs.edit()
          .remove(ReminderReceiver.PREFS_PENDING_DONE_ACTION)
          .remove(ReminderReceiver.PREFS_PENDING_DONE_ID)
          .apply()
      }
      return action
    }

    @JavascriptInterface
    fun consumePendingDoneTodoId(): String {
      val raw = consumePendingDoneAction()
      if (raw.isBlank()) return ""
      return try {
        JSONObject(raw).optString("id", "")
      } catch (_: Exception) {
        ""
      }
    }
  }
}
