package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : TauriActivity() {
  private val lightSystemBarColor = Color.rgb(248, 250, 252)
  private val darkSystemBarColor = Color.rgb(15, 15, 35)
  private val notificationIds = AtomicInteger(1000)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var currentWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // Android 15+ enforces edge-to-edge for targetSdk 35+.
    // Keep it enabled for correct system-bar contrast and apply real Insets
    // to the native content root that hosts the Tauri WebView.
    enableEdgeToEdge()
    applySystemBarsTheme(false)
    ReminderReceiver.createNotificationChannel(this)
    val doneActionId = persistDoneActionFromIntent(intent)
    super.onCreate(savedInstanceState)
    applySystemBarInsetsToContentRoot()
    if (doneActionId != null) tryCompleteTodoInWebView(doneActionId)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    val doneActionId = persistDoneActionFromIntent(intent)
    if (doneActionId != null) tryCompleteTodoInWebView(doneActionId)
  }

  private fun persistDoneActionFromIntent(intent: Intent?): String? {
    if (intent?.action != ReminderReceiver.ACTION_MARK_DONE) return null
    val id = intent.getStringExtra(ReminderReceiver.EXTRA_ID) ?: return null
    getSharedPreferences(ReminderReceiver.PREFS_NAME, MODE_PRIVATE)
      .edit()
      .putString(ReminderReceiver.PREFS_PENDING_DONE_ID, id)
      .apply()
    NotificationManagerCompat.from(this).cancel(id.hashCode().let { if (it == Int.MIN_VALUE) 0 else kotlin.math.abs(it) })
    return id
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    currentWebView = webView
    val nativeBridge = AndroidNativeBridge()
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidNative")
    webView.addJavascriptInterface(nativeBridge, "NiaAndroidSystemBars")
    webView.post { applySystemBarInsetsToContentRoot() }
    getPendingDoneTodoId()?.let { tryCompleteTodoInWebView(it) }
  }

  private fun getPendingDoneTodoId(): String? {
    val id = getSharedPreferences(ReminderReceiver.PREFS_NAME, MODE_PRIVATE)
      .getString(ReminderReceiver.PREFS_PENDING_DONE_ID, "")
      ?: ""
    return id.takeIf { it.isNotBlank() }
  }

  private fun clearPendingDoneTodoId(id: String) {
    val prefs = getSharedPreferences(ReminderReceiver.PREFS_NAME, MODE_PRIVATE)
    if (prefs.getString(ReminderReceiver.PREFS_PENDING_DONE_ID, "") == id) {
      prefs.edit().remove(ReminderReceiver.PREFS_PENDING_DONE_ID).apply()
    }
  }

  private fun tryCompleteTodoInWebView(id: String, attempt: Int = 0) {
    val webView = currentWebView
    if (webView == null) {
      if (attempt < 40) mainHandler.postDelayed({ tryCompleteTodoInWebView(id, attempt + 1) }, 750)
      return
    }

    // Execute once per notification action. evaluateJavascript does not await async promises,
    // so never retry based on its immediate return value.
    clearPendingDoneTodoId(id)
    val script = buildCompleteTodoScript(id)
    webView.post {
      webView.evaluateJavascript(script, null)
    }
  }

  private fun buildCompleteTodoScript(id: String): String {
    val quotedId = JSONObject.quote(id)
    return """
      (async function() {
        const rawId = $quotedId;
        const numericId = /^\d+$/.test(rawId) ? Number(rawId) : rawId;

        const dbNames = ['nia-todo-db', 'nia-todo-db'];
        function openDb(name) {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('open_failed'));
            request.onblocked = () => reject(new Error('open_blocked'));
          });
        }

        function getAll(store) {
          return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('get_all_failed'));
          });
        }

        for (const dbName of dbNames) {
          let db;
          try {
            db = await openDb(dbName);
            if (!db.objectStoreNames.contains('todos')) {
              db.close();
              continue;
            }
            const readTx = db.transaction('todos', 'readonly');
            const todos = await getAll(readTx.objectStore('todos'));
            const todo = todos.find((item) => item && (item.id === numericId || String(item.id) === rawId));
            if (!todo) {
              db.close();
              continue;
            }
            if (todo.status === 'done') {
              db.close();
              return 'done:already';
            }
            const updatedTodo = { ...todo, status: 'done', updated_at: new Date().toISOString() };
            await new Promise((resolve, reject) => {
              const stores = db.objectStoreNames.contains('syncQueue') ? ['todos', 'syncQueue'] : ['todos'];
              const tx = db.transaction(stores, 'readwrite');
              tx.objectStore('todos').put(updatedTodo);
              if (stores.includes('syncQueue')) {
                tx.objectStore('syncQueue').put({
                  action: 'UPDATE_TODO',
                  data: { id: todo.id, changes: { status: 'done' } },
                  timestamp: Date.now(),
                  localUpdatedAt: new Date().toISOString(),
                });
              }
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error || new Error('write_failed'));
            });
            db.close();
            setTimeout(() => location.reload(), 250);
            return 'done:' + dbName;
          } catch (error) {
            try { if (db) db.close(); } catch (_) {}
            console.warn('[NativeAction] IndexedDB fallback failed for ' + dbName, error);
          }
        }
        return 'not_found:' + rawId;
      })();
    """.trimIndent()
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
    fun consumePendingDoneTodoId(): String {
      val prefs = getSharedPreferences(ReminderReceiver.PREFS_NAME, MODE_PRIVATE)
      val id = prefs.getString(ReminderReceiver.PREFS_PENDING_DONE_ID, "") ?: ""
      if (id.isNotBlank()) {
        prefs.edit().remove(ReminderReceiver.PREFS_PENDING_DONE_ID).apply()
      }
      return id
    }
  }
}
