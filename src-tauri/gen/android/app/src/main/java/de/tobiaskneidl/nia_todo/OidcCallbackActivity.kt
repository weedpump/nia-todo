package de.tobiaskneidl.nia_todo

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

class OidcCallbackActivity : Activity() {
  private val nativePrefsName = "nia_todo_native"
  private val pendingOidcCallbackKey = "pending_oidc_callback_url"

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleCallback(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleCallback(intent)
  }

  private fun handleCallback(intent: Intent?) {
    try {
      val uri = intent?.data
      if (isOidcCallbackUri(uri)) {
        getSharedPreferences(nativePrefsName, MODE_PRIVATE)
          .edit()
          .putString(pendingOidcCallbackKey, uri.toString())
          .apply()
      }
      val launchIntent = Intent(this, MainActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addCategory(Intent.CATEGORY_LAUNCHER)
        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      startActivity(launchIntent)
    } catch (_: Exception) {
      // Keep the callback trampoline crash-safe. The user can always reopen the app.
    } finally {
      finish()
      overridePendingTransition(0, 0)
    }
  }

  private fun isOidcCallbackUri(uri: Uri?): Boolean {
    if (uri == null) return false
    return uri.scheme.equals("nia-todo", ignoreCase = true) &&
      uri.host.equals("oidc", ignoreCase = true) &&
      uri.path == "/callback"
  }
}
