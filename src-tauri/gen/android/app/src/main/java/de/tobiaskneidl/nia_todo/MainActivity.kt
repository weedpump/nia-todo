package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
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
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : TauriActivity() {
  private val lightSystemBarColor = Color.rgb(248, 250, 252)
  private val darkSystemBarColor = Color.rgb(15, 15, 35)
  private val notificationChannelId = "nia_todo_reminders"
  private val notificationIds = AtomicInteger(1000)

  override fun onCreate(savedInstanceState: Bundle?) {
    // Android 15+ enforces edge-to-edge for targetSdk 35+.
    // Keep it enabled for correct system-bar contrast and apply real Insets
    // to the native content root that hosts the Tauri WebView.
    enableEdgeToEdge()
    applySystemBarsTheme(false)
    createNotificationChannel()
    super.onCreate(savedInstanceState)
    applySystemBarInsetsToContentRoot()
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

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      notificationChannelId,
      "nia-todo Erinnerungen",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Native Benachrichtigungen für Todo-Erinnerungen"
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
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
    createNotificationChannel()

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
    val notification = NotificationCompat.Builder(this, notificationChannelId)
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
  }
}
