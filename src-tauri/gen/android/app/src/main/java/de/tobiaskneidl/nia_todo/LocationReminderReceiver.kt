package de.tobiaskneidl.nia_todo

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.location.Geocoder
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingEvent
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import org.json.JSONArray
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

class LocationReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      ACTION_GEOFENCE_EVENT -> handleGeofenceEvent(context, intent)
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_USER_UNLOCKED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      "android.intent.action.QUICKBOOT_POWERON" -> rescheduleStoredLocationReminders(context)
    }
  }

  private fun handleGeofenceEvent(context: Context, intent: Intent) {
    val event = GeofencingEvent.fromIntent(intent) ?: return
    if (event.hasError()) return
    val transition = event.geofenceTransition
    if (transition != Geofence.GEOFENCE_TRANSITION_ENTER && transition != Geofence.GEOFENCE_TRANSITION_EXIT) return

    val triggeredIds = event.triggeringGeofences?.mapNotNull { it.requestId }?.toSet().orEmpty()
    if (triggeredIds.isEmpty()) return

    val schedules = JSONArray(context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(PREFS_SCHEDULES, "[]") ?: "[]")
    for (index in 0 until schedules.length()) {
      val schedule = schedules.optJSONObject(index) ?: continue
      val id = schedule.optString("id")
      if (id.isBlank() || !triggeredIds.contains(id)) continue
      val wanted = schedule.optString("triggerType")
      val matchesTransition = (wanted == "arrival" && transition == Geofence.GEOFENCE_TRANSITION_ENTER) ||
        (wanted == "departure" && transition == Geofence.GEOFENCE_TRANSITION_EXIT)
      if (!matchesTransition) continue
      val title = schedule.optString("title").ifBlank { context.getString(R.string.location_reminder_fallback_title) }
      val body = schedule.optString("body").ifBlank { context.getString(R.string.location_reminder_fallback_body) }
      showLocationReminder(context, title, body, id, schedule.optString("userId", ""))
    }
  }

  private fun showLocationReminder(context: Context, title: String, body: String, id: String, userId: String) {
    if (!ReminderReceiver.hasNotificationPermission(context)) return
    val intent = Intent(context, ReminderReceiver::class.java).apply {
      action = ReminderReceiver.ACTION_SHOW_REMINDER
      putExtra(ReminderReceiver.EXTRA_ID, id)
      putExtra(ReminderReceiver.EXTRA_TITLE, title)
      putExtra(ReminderReceiver.EXTRA_BODY, body)
      putExtra(ReminderReceiver.EXTRA_USER_ID, userId)
    }
    ReminderReceiver().onReceive(context, intent)
  }

  companion object {
    const val ACTION_GEOFENCE_EVENT = "de.tobiaskneidl.nia_todo.LOCATION_REMINDER"
    const val PREFS_NAME = "nia_todo_location_reminders"
    const val PREFS_SCHEDULES = "location_schedules"
    const val DEFAULT_RADIUS_M = 150f

    fun hasStoredLocationSchedules(context: Context): Boolean {
      val schedulesJson = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(PREFS_SCHEDULES, "[]") ?: "[]"
      return try {
        JSONArray(schedulesJson).length() > 0
      } catch (_: Exception) {
        false
      }
    }

    fun locationPermissionState(context: Context): String {
      val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (!fine) return "prompt"
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "granted"
      val background = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
      return if (background) "granted" else "foreground_only"
    }

    fun scheduleLocationReminders(context: Context, schedulesJson: String): Int {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val oldSchedulesJson = prefs.getString(PREFS_SCHEDULES, "[]") ?: "[]"
      cancelLocationReminders(context, oldSchedulesJson)
      prefs.edit().putString(PREFS_SCHEDULES, schedulesJson).apply()
      return scheduleLocationRemindersFromJson(context, schedulesJson)
    }

    fun rescheduleStoredLocationReminders(context: Context): Int {
      val schedulesJson = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(PREFS_SCHEDULES, "[]") ?: "[]"
      return scheduleLocationRemindersFromJson(context, schedulesJson)
    }

    private fun scheduleLocationRemindersFromJson(context: Context, schedulesJson: String): Int {
      if (locationPermissionState(context) != "granted") return 0
      val schedules = JSONArray(schedulesJson)
      val geofences = mutableListOf<Geofence>()
      for (index in 0 until schedules.length()) {
        val schedule = schedules.optJSONObject(index) ?: continue
        val id = schedule.optString("id")
        val address = schedule.optString("address").trim()
        val resolved = resolveAddress(context, address) ?: continue
        val triggerType = schedule.optString("triggerType")
        if (id.isBlank()) continue
        val transition = when (triggerType) {
          "arrival" -> Geofence.GEOFENCE_TRANSITION_ENTER
          "departure" -> Geofence.GEOFENCE_TRANSITION_EXIT
          else -> continue
        }
        geofences.add(
          Geofence.Builder()
            .setRequestId(id)
            .setCircularRegion(resolved.first, resolved.second, DEFAULT_RADIUS_M)
            .setExpirationDuration(Geofence.NEVER_EXPIRE)
            .setTransitionTypes(transition)
            .build()
        )
      }
      if (geofences.isEmpty()) return 0
      val request = GeofencingRequest.Builder()
        .setInitialTrigger(0)
        .addGeofences(geofences)
        .build()
      return try {
        val success = AtomicBoolean(false)
        val latch = CountDownLatch(1)
        geofencingClient(context).addGeofences(request, geofencePendingIntent(context))
          .addOnSuccessListener {
            success.set(true)
            latch.countDown()
          }
          .addOnFailureListener {
            success.set(false)
            latch.countDown()
          }
        if (Looper.myLooper() == Looper.getMainLooper()) return geofences.size
        latch.await(3, TimeUnit.SECONDS)
        if (success.get()) geofences.size else 0
      } catch (_: SecurityException) {
        0
      } catch (_: Exception) {
        0
      }
    }

    private fun resolveAddress(context: Context, address: String): Pair<Double, Double>? {
      if (address.isBlank()) return null
      return try {
        @Suppress("DEPRECATION")
        val results = Geocoder(context, Locale.getDefault()).getFromLocationName(address, 1)
        val first = results?.firstOrNull() ?: return null
        Pair(first.latitude, first.longitude)
      } catch (_: Exception) {
        null
      }
    }

    private fun cancelLocationReminders(context: Context, schedulesJson: String) {
      val schedules = JSONArray(schedulesJson)
      val ids = mutableListOf<String>()
      for (index in 0 until schedules.length()) {
        val id = schedules.optJSONObject(index)?.optString("id") ?: continue
        if (id.isNotBlank()) ids.add(id)
      }
      if (ids.isEmpty()) return
      try {
        geofencingClient(context).removeGeofences(ids)
      } catch (_: Exception) {
        // Best-effort cleanup; replacing schedules with the same request ids remains safe.
      }
    }

    private fun geofencingClient(context: Context): GeofencingClient {
      return LocationServices.getGeofencingClient(context)
    }

    private fun geofencePendingIntent(context: Context): PendingIntent {
      val intent = Intent(context, LocationReminderReceiver::class.java).apply { action = ACTION_GEOFENCE_EVENT }
      return PendingIntent.getBroadcast(
        context,
        4242,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      )
    }
  }
}
