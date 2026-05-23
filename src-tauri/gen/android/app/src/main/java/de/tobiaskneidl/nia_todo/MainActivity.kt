package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : TauriActivity() {
  private val nativePrefsName = "nia_todo_native"
  private val lastWebViewCacheVersionKey = "last_webview_cache_version"
  private val lightSystemBarColor = Color.rgb(248, 250, 252)
  private val darkSystemBarColor = Color.rgb(15, 15, 35)
  private val notificationIds = AtomicInteger(1000)

  override fun onCreate(savedInstanceState: Bundle?) {
    // Android 15+ enforces edge-to-edge for targetSdk 35+.
    // Keep it enabled for correct system-bar contrast and apply real Insets
    // to the native content root that hosts the Tauri WebView.
    enableEdgeToEdge()
    applySystemBarsTheme(false)
    ReminderReceiver.createNotificationChannel(this)
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
    val nativeBridge = AndroidNativeBridge()
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidNative")
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidSystemBars")
    webView.post { applySystemBarInsetsToContentRoot() }
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
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
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
